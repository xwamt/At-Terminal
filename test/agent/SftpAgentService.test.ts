import { describe, expect, it, vi } from 'vitest';
import { SftpAgentService, type AgentSftpSession } from '../../src/agent/SftpAgentService';
import type { ServerConfig } from '../../src/config/schema';
import type { SftpEntry } from '../../src/sftp/SftpTypes';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(id = 'server-1', overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
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

function missingPathError(): Error & { code: number } {
  const error = new Error('No such file') as Error & { code: number };
  error.code = 2;
  return error;
}

// `any` keeps individually-typed vi.fn mocks assignable; tests cast the result at use sites.
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

describe('SftpAgentService', () => {
  it('lists a directory using the default connected terminal', async () => {
    const session = makeSession({
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ path: '.' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy',
      entries: [{ name: 'app.js', path: '/home/deploy/app.js', type: 'file', size: 10, modifiedAt: 1 }],
      truncated: false,
      offset: 0,
      total: 1
    });
  });

  it('truncates directory listings when entries exceed maxEntries', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: index,
      modifiedAt: index
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ path: '/tmp', maxEntries: 5 })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/tmp',
      entries: entries.slice(0, 5),
      truncated: true,
      offset: 0,
      total: 12
    });
  });

  it('pages directory listings with offset', async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: index,
      modifiedAt: index
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    const middle = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 5 });
    expect(middle.entries).toEqual(entries.slice(5, 10));
    expect(middle.truncated).toBe(true);
    expect(middle.offset).toBe(5);
    expect(middle.total).toBe(12);

    const lastPage = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 10 });
    expect(lastPage.entries).toEqual(entries.slice(10));
    expect(lastPage.truncated).toBe(false);

    const beyond = await service.listDirectory({ path: '/tmp', maxEntries: 5, offset: 50 });
    expect(beyond.entries).toEqual([]);
    expect(beyond.truncated).toBe(false);
    expect(beyond.total).toBe(12);
  });

  it('defaults maxEntries to 500 and clamps oversized requests', async () => {
    const entries = Array.from({ length: 600 }, (_, index) => ({
      name: `file-${index}.txt`,
      path: `/tmp/file-${index}.txt`,
      type: 'file' as const,
      size: 1,
      modifiedAt: 1
    }));
    const session = makeSession({
      realpath: vi.fn(async () => '/tmp'),
      listDirectory: vi.fn(async () => entries)
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    const defaulted = await service.listDirectory({ path: '/tmp' });
    expect(defaulted.truncated).toBe(true);
    expect(defaulted.total).toBe(600);
    expect(defaulted.entries).toHaveLength(500);

    const clamped = await service.listDirectory({ path: '/tmp', maxEntries: 50_000 });
    expect(clamped.entries).toHaveLength(600);
    expect(clamped.truncated).toBe(false);
    expect(clamped.total).toBe(600);
  });

  it('reads bounded UTF-8 text and reports truncation', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/home/deploy/app.txt', maxBytes: 5 })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/app.txt',
      content: 'hello',
      truncated: true,
      offset: 0,
      size: 11,
      modifiedAt: 123
    });
    expect(session.readFile).toHaveBeenCalledWith('/home/deploy/app.txt', 5, 0);
  });

  it('reads from a positive byte offset', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', maxBytes: 5, offset: 6 })).resolves.toMatchObject({
      content: 'world',
      truncated: false,
      offset: 6,
      size: 11
    });
    expect(session.readFile).toHaveBeenCalledWith('/app.txt', 5, 6);
  });

  it('reads the tail of a file for a negative offset', async () => {
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 123 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', offset: -5 })).resolves.toMatchObject({
      content: 'world',
      truncated: false,
      offset: 6
    });
    // A tail larger than the file starts at byte 0 rather than failing.
    await expect(service.readFile({ path: '/app.txt', offset: -500 })).resolves.toMatchObject({
      content: 'hello world',
      offset: 0,
      truncated: false
    });
  });

  it('returns empty content when the offset is at or past the end of the file', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 11, modifiedAt: 123 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/app.txt', offset: 999 })).resolves.toMatchObject({
      content: '',
      truncated: false,
      offset: 11
    });
    expect(session.readFile).not.toHaveBeenCalled();
  });

  it('rejects binary-looking file content', async () => {
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 3, modifiedAt: 1 })),
      readFile: vi.fn(async () => Buffer.from([0x61, 0x00, 0x62]))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.readFile({ path: '/bin.dat' })).rejects.toThrow('Remote file appears to be binary.');
  });

  it('requires authorization and overwrite flag before writing existing files', async () => {
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: '/app.txt', content: 'next' })).rejects.toThrow(
      'Remote file already exists. Pass overwrite: true to replace it.'
    );
    await expect(service.writeFile({ path: '/app.txt', content: 'next', overwrite: true })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/app.txt',
      bytesWritten: 4,
      overwritten: true
    });
    expect(auth.requireWrite).toHaveBeenCalledTimes(1);
    expect(session.writeFile).toHaveBeenCalledWith('/app.txt', Buffer.from('next', 'utf8'));
  });

  it('returns a timeout error instead of hanging when a remote write never completes', async () => {
    vi.useFakeTimers();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 })),
      writeFile: vi.fn(() => new Promise<void>(() => undefined))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    try {
      const write = service.writeFile({ path: '/app.txt', content: 'next', overwrite: true });
      await Promise.resolve();
      await Promise.resolve();
      const expectation = expect(write).rejects.toThrow('Timed out writing remote file /app.txt.');
      await vi.advanceTimersByTimeAsync(60_000);

      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes new files by resolving the parent directory instead of the leaf path', async () => {
    const auth = authorizer();
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => {
        if (path === '.') {
          return '/home/deploy';
        }
        if (path === '/home/deploy') {
          return '/home/deploy';
        }
        throw new Error(`missing path: ${path}`);
      }),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: 'new.txt', content: 'hello' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/new.txt',
      bytesWritten: 5,
      overwritten: false
    });
    expect(session.realpath).not.toHaveBeenCalledWith('/home/deploy/new.txt');
    expect(session.writeFile).toHaveBeenCalledWith('/home/deploy/new.txt', Buffer.from('hello', 'utf8'));
  });

  it('does not treat stat permission errors as missing paths before writing', async () => {
    const permissionError = new Error('Permission denied');
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => {
        throw permissionError;
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.writeFile({ path: 'locked.txt', content: 'hello' })).rejects.toThrow('Permission denied');
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.writeFile).not.toHaveBeenCalled();
  });

  it('tells the authorizer which directory the session started in', async () => {
    const auth = authorizer();
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/home/deploy/app' : path)),
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await service.writeFile({ path: 'notes.txt', content: 'hello' });
    await service.createFile({ path: '/etc/cron.d/task' });
    await service.createDirectory({ path: '/var/www/html' });

    expect(auth.requireWrite).toHaveBeenNthCalledWith(1, expect.anything(), {
      operation: 'write_file',
      path: '/home/deploy/app/notes.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(2, expect.anything(), {
      operation: 'create_file',
      path: '/etc/cron.d/task',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(3, expect.anything(), {
      operation: 'create_directory',
      path: '/var/www/html',
      overwrite: false,
      workspaceRoot: '/home/deploy/app'
    });
  });

  it('creates new directories by resolving the parent directory instead of the leaf path', async () => {
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => {
        if (path === '.' || path === '/var/tmp') {
          return path === '.' ? '/home/deploy' : '/var/tmp';
        }
        throw new Error(`missing path: ${path}`);
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.createDirectory({ path: '/var/tmp/new-dir/' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/var/tmp/new-dir'
    });
    expect(session.realpath).not.toHaveBeenCalledWith('/var/tmp/new-dir');
    expect(session.mkdir).toHaveBeenCalledWith('/var/tmp/new-dir');
  });
});

describe('SftpAgentService rename', () => {
  it('authorizes both the source and the destination before renaming', async () => {
    const auth = authorizer();
    const existing = new Set(['/home/deploy/old.txt']);
    const session = makeSession({
      stat: vi.fn(async (path: string) => {
        if (existing.has(path)) {
          return { size: 4, modifiedAt: 1 };
        }
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.rename({ path: 'old.txt', newPath: 'new.txt' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/old.txt',
      newPath: '/home/deploy/new.txt'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(1, expect.anything(), {
      operation: 'rename',
      path: '/home/deploy/old.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(auth.requireWrite).toHaveBeenNthCalledWith(2, expect.anything(), {
      operation: 'rename',
      path: '/home/deploy/new.txt',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(session.rename).toHaveBeenCalledWith('/home/deploy/old.txt', '/home/deploy/new.txt');
    expect(auth.requireDelete).not.toHaveBeenCalled();
  });

  it('refuses to rename onto an existing destination', async () => {
    const auth = authorizer();
    const session = makeSession({
      stat: vi.fn(async () => ({ size: 4, modifiedAt: 1 }))
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.rename({ path: '/a.txt', newPath: '/b.txt' })).rejects.toThrow(
      'Remote destination already exists.'
    );
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.rename).not.toHaveBeenCalled();
  });

  it('refuses to rename a missing source', async () => {
    const session = makeSession({
      stat: vi.fn(async () => {
        throw missingPathError();
      })
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.rename({ path: '/a.txt', newPath: '/b.txt' })).rejects.toThrow(
      'Remote source path was not found.'
    );
    expect(session.rename).not.toHaveBeenCalled();
  });
});

describe('SftpAgentService delete', () => {
  function listing(entries: SftpEntry[]) {
    return vi.fn(async () => entries);
  }

  it('deletes a file after the dedicated delete confirmation, never through requireWrite', async () => {
    const auth = authorizer();
    const session = makeSession({
      listDirectory: listing([
        { name: 'app.log', path: '/home/deploy/app.log', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'app.log' })).resolves.toEqual({
      terminalId: 'terminal-1',
      serverId: 'server-1',
      path: '/home/deploy/app.log',
      deleted: true
    });
    expect(auth.requireDelete).toHaveBeenCalledWith(expect.anything(), {
      operation: 'delete_file',
      path: '/home/deploy/app.log',
      overwrite: false,
      workspaceRoot: '/home/deploy'
    });
    expect(auth.requireWrite).not.toHaveBeenCalled();
    expect(session.deleteFile).toHaveBeenCalledWith('/home/deploy/app.log');
  });

  it('refuses to delete directories', async () => {
    const auth = authorizer();
    const session = makeSession({
      listDirectory: listing([
        { name: 'logs', path: '/home/deploy/logs', type: 'directory', size: 0, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'logs' })).rejects.toThrow(
      'sftp_delete removes single files only; directories are refused.'
    );
    expect(auth.requireDelete).not.toHaveBeenCalled();
    expect(session.deleteFile).not.toHaveBeenCalled();
  });

  it('refuses to delete a missing file', async () => {
    const session = makeSession({ listDirectory: listing([]) });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await expect(service.deleteFile({ path: 'gone.txt' })).rejects.toThrow('Remote file was not found.');
    expect(session.deleteFile).not.toHaveBeenCalled();
  });

  it('does not delete when the user cancels the confirmation', async () => {
    const auth = authorizer();
    auth.requireDelete.mockRejectedValue(new Error('SFTP delete was cancelled.'));
    const session = makeSession({
      listDirectory: listing([
        { name: 'app.log', path: '/home/deploy/app.log', type: 'file', size: 10, modifiedAt: 1 }
      ])
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: auth
    });

    await expect(service.deleteFile({ path: 'app.log' })).rejects.toThrow('SFTP delete was cancelled.');
    expect(session.deleteFile).not.toHaveBeenCalled();
  });
});

describe('SftpAgentService background sessions', () => {
  it('rejects servers that do not allow background connections when no terminal is connected', async () => {
    const createSession = vi.fn();
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: false })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow(
      'does not allow background connections'
    );
    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow(
      'Allow background connections'
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('serves an authorized server without any connected UI terminal', async () => {
    const session = makeSession({
      realpath: vi.fn(async (path = '.') => (path === '.' ? '/srv/app' : path)),
      listDirectory: vi.fn(async () => [
        { name: 'app.js', path: '/srv/app/app.js', type: 'file' as const, size: 10, modifiedAt: 1 }
      ])
    });
    const createSession = vi.fn(() => session);
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).resolves.toEqual({
      terminalId: undefined,
      serverId: 'server-9',
      path: '/srv/app',
      entries: [{ name: 'app.js', path: '/srv/app/app.js', type: 'file', size: 10, modifiedAt: 1 }],
      truncated: false,
      offset: 0,
      total: 1
    });
    expect(createSession).toHaveBeenCalledWith({
      server: expect.objectContaining({ id: 'server-9', backgroundConnectionAllowed: true })
    });
  });

  it('reports missing servers clearly', async () => {
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: vi.fn() as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async () => undefined
    });

    await expect(service.statPath({ serverId: 'ghost', path: '/etc/hosts' })).rejects.toThrow(
      'SSH server "ghost" was not found.'
    );
  });

  it('keeps the old error when background resolution is not wired', async () => {
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: vi.fn() as never,
      authorizer: authorizer()
    });

    await expect(service.listDirectory({ serverId: 'server-9' })).rejects.toThrow(
      'No matching connected AT Terminal SSH session is available.'
    );
  });

  it('pools background sessions by server and reaps them after five idle minutes', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        realpath: vi.fn(async () => '/srv/app'),
        listDirectory: vi.fn(async () => [])
      });
      const createSession = vi.fn(() => session);
      const service = new SftpAgentService({
        terminalContext: new TerminalContextRegistry(),
        createSession: createSession as never,
        authorizer: authorizer(),
        resolveBackgroundServer: async (serverId) =>
          server(serverId, { backgroundConnectionAllowed: true })
      });

      await service.listDirectory({ serverId: 'server-9', path: '.' });
      await service.listDirectory({ serverId: 'server-9', path: '.' });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(session.dispose).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(session.dispose).toHaveBeenCalledTimes(1);

      // The next call opens a fresh session instead of reusing the reaped one.
      await service.listDirectory({ serverId: 'server-9', path: '.' });
      expect(createSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disposes a failed background connection and surfaces the error', async () => {
    const session = makeSession({
      connect: vi.fn(async () => {
        throw new Error('auth failed');
      })
    });
    const createSession = vi.fn(() => session);
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: createSession as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await expect(service.listDirectory({ serverId: 'server-9', path: '.' })).rejects.toThrow('auth failed');
    expect(session.dispose).toHaveBeenCalled();
  });
});

describe('SftpAgentService disposal', () => {
  it('disposeTerminal drops the pooled session for a closed terminal', async () => {
    const session = makeSession();
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer()
    });

    await service.listDirectory({ path: '.' });
    expect(session.dispose).not.toHaveBeenCalled();

    service.disposeTerminal('terminal-1');
    await Promise.resolve();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposeServer drops background and terminal sessions for that server', async () => {
    const terminalSession = makeSession();
    const backgroundSession = makeSession();
    const registry = connectedRegistry();
    let calls = 0;
    const service = new SftpAgentService({
      terminalContext: registry,
      createSession: (() => {
        calls += 1;
        return calls === 1 ? terminalSession : backgroundSession;
      }) as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await service.listDirectory({ terminalId: 'terminal-1', path: '.' });
    registry.clearIfActive('terminal-1');
    await service.listDirectory({ serverId: 'server-1', path: '.' });
    expect(calls).toBe(2);

    service.disposeServer('server-1');
    await Promise.resolve();
    expect(terminalSession.dispose).toHaveBeenCalledTimes(1);
    expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('dispose closes every pooled session', async () => {
    const terminalSession = makeSession();
    const backgroundSession = makeSession();
    const registry = connectedRegistry();
    let calls = 0;
    const service = new SftpAgentService({
      terminalContext: registry,
      createSession: (() => {
        calls += 1;
        return calls === 1 ? terminalSession : backgroundSession;
      }) as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: true })
    });

    await service.listDirectory({ terminalId: 'terminal-1', path: '.' });
    registry.clearIfActive('terminal-1');
    await service.listDirectory({ serverId: 'server-2', path: '.' });

    service.dispose();
    await Promise.resolve();
    expect(terminalSession.dispose).toHaveBeenCalledTimes(1);
    expect(backgroundSession.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('SftpAgentService audit', () => {
  it('records successful reads and refused background calls', async () => {
    const record = vi.fn();
    const content = Buffer.from('hello world', 'utf8');
    const session = makeSession({
      stat: vi.fn(async () => ({ size: content.length, modifiedAt: 1 })),
      readFile: vi.fn(async (_path: string, maxBytes: number, offset = 0) =>
        content.subarray(offset, offset + maxBytes)
      )
    });
    const service = new SftpAgentService({
      terminalContext: connectedRegistry(),
      createSession: () => session as never,
      authorizer: authorizer(),
      resolveBackgroundServer: async (serverId) =>
        server(serverId, { backgroundConnectionAllowed: false }),
      audit: { record }
    });

    await service.readFile({ path: '/app.txt', maxBytes: 5 });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'sftp_read_file',
        serverId: 'server-1',
        terminalId: 'terminal-1',
        path: '/app.txt',
        reasonCode: 'ok',
        truncated: true,
        durationMs: expect.any(Number)
      })
    );

    await expect(service.readFile({ serverId: 'server-9', path: '/x', terminalId: undefined })).rejects.toThrow();
    expect(record).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tool: 'sftp_read_file',
        serverId: 'server-9',
        reasonCode: 'background_denied'
      })
    );
  });
});
