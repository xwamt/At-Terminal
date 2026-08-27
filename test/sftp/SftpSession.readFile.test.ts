import { describe, expect, it, vi } from 'vitest';
import { SFTP_CHUNK_BYTES, SFTP_PIPELINE_DEPTH, SftpSession } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

vi.mock('ssh2', () => ({ Client: vi.fn() }));

function server(): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function session(sftp: Record<string, unknown>): SftpSession {
  const instance = new SftpSession(
    server(),
    { getPassword: async () => 'secret' },
    { verify: async () => true },
    { allowSudoFallback: false }
  );
  (instance as unknown as { sftp: unknown }).sftp = sftp;
  return instance;
}

/** In-memory remote file: open/fstat/read/close resolve against `content` synchronously. */
function remoteFile(content: Buffer) {
  const handle = Buffer.from('handle');
  return {
    open: vi.fn((_path: string, _flags: string, callback: (error?: Error, handle?: Buffer) => void) =>
      callback(undefined, handle)
    ),
    fstat: vi.fn((_handle: Buffer, callback: (error?: Error, stats?: { size: number }) => void) =>
      callback(undefined, { size: content.byteLength })
    ),
    read: vi.fn(
      (
        _handle: Buffer,
        destination: Buffer,
        destinationOffset: number,
        length: number,
        position: number,
        callback: (error?: Error, bytesRead?: number) => void
      ) => {
        const available = Math.max(0, content.byteLength - position);
        const bytesRead = Math.min(length, available);
        content.copy(destination, destinationOffset, position, position + bytesRead);
        callback(undefined, bytesRead);
      }
    ),
    close: vi.fn((_handle: Buffer, callback: (error?: Error) => void) => callback())
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('SftpSession readFile offsets', () => {
  const content = Buffer.from('0123456789');

  it('reads from the start by default', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 4)).resolves.toEqual(Buffer.from('0123'));
  });

  it('reads the whole file when maxBytes exceeds its size', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 1024)).resolves.toEqual(content);
  });

  it('reads from a positive offset', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 4, 4)).resolves.toEqual(Buffer.from('4567'));
    await expect(sftp.readFile('/srv/file', 100, 8)).resolves.toEqual(Buffer.from('89'));
  });

  it('reads a tail with a negative offset', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 100, -3)).resolves.toEqual(Buffer.from('789'));
    await expect(sftp.readFile('/srv/file', 2, -3)).resolves.toEqual(Buffer.from('78'));
  });

  it('clamps a negative offset larger than the file to the start', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 100, -1000)).resolves.toEqual(content);
  });

  it('returns an empty buffer past the end of the file', async () => {
    const sftp = session(remoteFile(content));
    await expect(sftp.readFile('/srv/file', 10, 50)).resolves.toEqual(Buffer.alloc(0));
    await expect(sftp.readFile('/srv/file', 0)).resolves.toEqual(Buffer.alloc(0));
  });

  it('closes the handle after reading', async () => {
    const fake = remoteFile(content);
    const sftp = session(fake);
    await sftp.readFile('/srv/file', 4);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe('SftpSession readFile pipelining', () => {
  it('keeps a sliding window of chunk reads in flight instead of one round trip at a time', async () => {
    const chunkCount = SFTP_PIPELINE_DEPTH + 2;
    const content = Buffer.alloc(chunkCount * SFTP_CHUNK_BYTES);
    for (let index = 0; index < chunkCount; index += 1) {
      content.fill(index + 1, index * SFTP_CHUNK_BYTES, (index + 1) * SFTP_CHUNK_BYTES);
    }
    const pending: Array<{
      destination: Buffer;
      destinationOffset: number;
      length: number;
      position: number;
      callback: (error?: Error, bytesRead?: number) => void;
    }> = [];
    const fake = remoteFile(content);
    fake.read.mockImplementation(
      (_handle, destination, destinationOffset, length, position, callback) => {
        pending.push({ destination, destinationOffset, length, position, callback });
      }
    );
    const sftp = session(fake);

    const result = sftp.readFile('/srv/big', content.byteLength);
    await flush();

    expect(pending).toHaveLength(SFTP_PIPELINE_DEPTH);

    while (pending.length > 0) {
      const request = pending.shift()!;
      content.copy(
        request.destination,
        request.destinationOffset,
        request.position,
        request.position + request.length
      );
      request.callback(undefined, request.length);
      await flush();
    }

    await expect(result).resolves.toEqual(content);
    expect(fake.read).toHaveBeenCalledTimes(chunkCount);
  });
});

describe('SftpSession writeFile pipelining', () => {
  it('keeps a sliding window of chunk writes in flight at fixed offsets', async () => {
    const chunkCount = 5;
    const content = Buffer.alloc(chunkCount * SFTP_CHUNK_BYTES, 7);
    const pending: Array<{ position: number; callback: (error?: Error) => void }> = [];
    const handle = Buffer.from('handle');
    const open = vi.fn((_path, _flags, callback: (error?: Error, handle?: Buffer) => void) =>
      callback(undefined, handle)
    );
    const write = vi.fn(
      (
        _handle: Buffer,
        _buffer: Buffer,
        _offset: number,
        _length: number,
        position: number,
        callback: (error?: Error) => void
      ) => {
        pending.push({ position, callback });
      }
    );
    const close = vi.fn((_handle: Buffer, callback: (error?: Error) => void) => callback());
    const sftp = session({ open, write, close });

    const result = sftp.writeFile('/srv/big', content);
    await flush();

    expect(pending).toHaveLength(chunkCount);
    expect(pending.map((request) => request.position)).toEqual(
      Array.from({ length: chunkCount }, (_item, index) => index * SFTP_CHUNK_BYTES)
    );

    while (pending.length > 0) {
      pending.shift()!.callback();
      await flush();
    }

    await result;
    expect(close).toHaveBeenCalledWith(handle, expect.any(Function));
  });
});
