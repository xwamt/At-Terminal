import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildSftpConnectConfig } from '../../src/sftp/SftpSession';
import { SftpSession } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

function server(authType: 'password' | 'privateKey'): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    authType,
    privateKeyPath: authType === 'privateKey' ? 'C:/keys/id_rsa' : undefined,
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('buildSftpConnectConfig', () => {
  it('uses the stored password for password auth', async () => {
    const config = await buildSftpConnectConfig(server('password'), {
      getPassword: async () => 'secret'
    });

    expect(config).toMatchObject({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      password: 'secret',
      keepaliveInterval: 15000
    });
  });

  it('rejects missing passwords', async () => {
    await expect(
      buildSftpConnectConfig(server('password'), {
        getPassword: async () => undefined
      })
    ).rejects.toThrow('Missing password');
  });
});

describe('SftpSession uploadFile sudo fallback', () => {
  it('uploads to /tmp and uses sudo when direct upload is permission denied', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.uploadFile('C:/tmp/app.conf', '/etc/app.conf');

    expect(fastPut).toHaveBeenCalledTimes(2);
    expect(fastPut.mock.calls[0][1]).toBe('/etc/app.conf');
    expect(fastPut.mock.calls[1][1]).toMatch(/^\/tmp\/at-terminal-upload-.+-app\.conf$/);
    expect(sudoCommand).toContain('sudo -n sh -c');
    expect(sudoCommand).toContain('/etc/app.conf');
    expect(sudoCommand).toContain(fastPut.mock.calls[1][1]);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('reports sudo fallback stderr when elevated upload also fails', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
          stream.emit('close', 1);
        });
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await expect(session.uploadFile('C:/tmp/app.conf', '/etc/app.conf')).rejects.toThrow(
      'sudo: a password is required'
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/at-terminal-upload-.+-app\.conf$/), expect.any(Function));
  });
});

describe('SftpSession writeFile sudo fallback', () => {
  it('writes to /tmp and uses sudo when direct write is permission denied', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'));

    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0][0]).toBe('/root/README-base.md');
    expect(open.mock.calls[1][0]).toMatch(/^\/tmp\/at-terminal-write-.+-README-base\.md$/);
    expect(write).toHaveBeenCalledWith(tempHandle, Buffer.from('hello', 'utf8'), 0, 5, 0, expect.any(Function));
    expect(close).toHaveBeenCalledWith(tempHandle, expect.any(Function));
    expect(sudoCommand).toContain('sudo -n sh -c');
    expect(sudoCommand).toContain('/root/README-base.md');
    expect(sudoCommand).toContain(open.mock.calls[1][0]);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('reports sudo stderr when elevated write also fails', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
          stream.emit('close', 1);
        });
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await expect(session.writeFile('/root/README-base.md', Buffer.from('hello', 'utf8'))).rejects.toThrow(
      'sudo: a password is required'
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/at-terminal-write-.+-README-base\.md$/), expect.any(Function));
  });
});

describe('SftpSession createFile sudo fallback', () => {
  it('creates an empty protected file through the sudo write fallback', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const tempHandle = Buffer.from('temp-handle');
    const open = vi
      .fn()
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(permissionDenied))
      .mockImplementationOnce((_remotePath, _flags, callback) => callback(undefined, tempHandle));
    const write = vi.fn((_handle, _buffer, _offset, length, _position, callback) => callback(undefined, length));
    const close = vi.fn((_handle, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { open, write, close, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.createFile('/root/empty.txt');

    expect(open.mock.calls[0][0]).toBe('/root/empty.txt');
    expect(open.mock.calls[0][1]).toBe('wx');
    expect(open.mock.calls[1][0]).toBe('/root/empty.txt');
    expect(open.mock.calls[1][1]).toBe('w');
    expect(open.mock.calls[2][0]).toMatch(/^\/tmp\/at-terminal-write-.+-empty\.txt$/);
    expect(write).not.toHaveBeenCalled();
    expect(sudoCommand).toContain('/root/empty.txt');
    expect(sudoCommand).toContain(open.mock.calls[2][0]);
  });
});

class FakeExecStream extends EventEmitter {
  readonly stderr = new EventEmitter();
}
