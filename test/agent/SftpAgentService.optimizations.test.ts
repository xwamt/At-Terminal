import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SftpAgentService, type AgentSftpSession } from '../../src/agent/SftpAgentService';
import type { ServerConfig } from '../../src/config/schema';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'server-1',
    host: 'server-1.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function connectedRegistry(): TerminalContextRegistry {
  const registry = new TerminalContextRegistry();
  registry.setActive({
    terminalId: 'terminal-1',
    server: server(),
    connected: true,
    write: vi.fn()
  });
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSession(overrides: Partial<Record<keyof AgentSftpSession, any>> = {}) {
  return {
    connect: vi.fn(async () => undefined),
    realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy' : path)),
    listDirectory: vi.fn(async () => []),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 1 })),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    createFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...overrides
  };
}

function authorizer() {
  return { requireWrite: vi.fn(async () => undefined), requireDelete: vi.fn(async () => undefined) };
}

function serviceWith(session: ReturnType<typeof makeSession>) {
  return new SftpAgentService({
    terminalContext: connectedRegistry(),
    createSession: () => session as never,
    authorizer: authorizer()
  });
}

function missingPathError(): Error & { code: number } {
  const error = new Error('No such file') as Error & { code: number };
  error.code = 2;
  return error;
}

describe('SftpAgentService read timeouts', () => {
  it('fails a hung listDirectory instead of parking the tool call', async () => {
    vi.useFakeTimers();
    const session = makeSession({ listDirectory: vi.fn(() => new Promise(() => undefined)) });
    const service = serviceWith(session);
    try {
      const expectation = expect(service.listDirectory({ path: '/tmp' })).rejects.toThrow(
        'Timed out listing remote directory /tmp after 30000ms.'
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a hung statPath instead of parking the tool call', async () => {
    vi.useFakeTimers();
    const session = makeSession({ stat: vi.fn(() => new Promise(() => undefined)) });
    const service = serviceWith(session);
    try {
      const expectation = expect(service.statPath({ path: '/tmp/app.conf' })).rejects.toThrow(
        'Timed out reading metadata for /tmp/app.conf after 30000ms.'
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a hung readFile instead of parking the tool call', async () => {
    vi.useFakeTimers();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 10, modifiedAt: 1 })),
      readFile: vi.fn(() => new Promise(() => undefined))
    });
    const service = serviceWith(session);
    try {
      const expectation = expect(service.readFile({ path: '/tmp/app.log' })).rejects.toThrow(
        'Timed out reading remote file /tmp/app.log after 30000ms.'
      );
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SftpAgentService home expansion', () => {
  it('expands ~ and ~/... against the session root', async () => {
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy' : path))
    });
    const service = serviceWith(session);

    await expect(service.listDirectory({ path: '~' })).resolves.toMatchObject({ path: '/home/deploy' });
    await expect(service.listDirectory({ path: '~/.bashrc' })).resolves.toMatchObject({
      path: '/home/deploy/.bashrc'
    });
  });

  it('expands ~ for writable paths too', async () => {
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = serviceWith(session);

    await service.writeFile({ path: '~/app.conf', content: 'x' });
    expect(session.writeFile).toHaveBeenCalledWith('/home/deploy/app.conf', Buffer.from('x'));
  });
});

describe('SftpAgentService editFile', () => {
  it('replaces a unique literal without rewriting the rest of the file', async () => {
    const original = 'server {\n  listen 80;\n}\n';
    const session = makeSession({
      stat: vi.fn(async () => ({ size: Buffer.byteLength(original), modifiedAt: 10 })),
      readFile: vi.fn(async () => Buffer.from(original, 'utf8'))
    });
    const service = serviceWith(session);

    const result = await service.editFile({
      path: '/etc/nginx/nginx.conf',
      oldText: 'listen 80;',
      newText: 'listen 8080;'
    });

    expect(result.replacements).toBe(1);
    expect(session.writeFile).toHaveBeenCalledWith(
      '/etc/nginx/nginx.conf',
      Buffer.from('server {\n  listen 8080;\n}\n', 'utf8')
    );
  });

  it('rejects an edit when the remote file changed since it was read', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 100, modifiedAt: 99 })),
      readFile: vi.fn(async () => Buffer.alloc(100))
    });
    const service = serviceWith(session);

    await expect(
      service.editFile({ path: '/etc/app.conf', oldText: 'a', newText: 'b', expectedSize: 50 })
    ).rejects.toThrow('Remote file changed: expected size 50, found 100.');
  });

  it('requires replaceAll when oldText appears more than once', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 6, modifiedAt: 1 })),
      readFile: vi.fn(async () => Buffer.from('a a a\n'))
    });
    const service = serviceWith(session);

    await expect(
      service.editFile({ path: '/tmp/app.txt', oldText: 'a', newText: 'b' })
    ).rejects.toThrow('oldText matched 3 times; pass replaceAll: true');
    await expect(
      service.editFile({ path: '/tmp/app.txt', oldText: 'a', newText: 'b', replaceAll: true })
    ).resolves.toMatchObject({ replacements: 3 });
  });

  it('refuses to edit a file larger than the in-place limit', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 3 * 1024 * 1024, modifiedAt: 1 }))
    });
    const service = serviceWith(session);

    await expect(
      service.editFile({ path: '/var/log/huge.log', oldText: 'a', newText: 'b' })
    ).rejects.toThrow('too large for in-place editing');
    expect(session.readFile).not.toHaveBeenCalled();
  });
});

describe('SftpAgentService localPath upload', () => {
  it('streams a host file and reports its byte size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sftp-agent-local-'));
    const localPath = join(directory, 'payload.bin');
    await writeFile(localPath, 'hello');
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      }),
      uploadFile: vi.fn(async () => undefined)
    });
    const service = serviceWith(session);

    try {
      const result = await service.writeFile({ path: '/tmp/payload.bin', localPath });
      expect(result.bytesWritten).toBe(5);
      expect(session.uploadFile).toHaveBeenCalledWith(expect.stringMatching(/payload\.bin$/), '/tmp/payload.bin', undefined, {
        overwrite: false
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
