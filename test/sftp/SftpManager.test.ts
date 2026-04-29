import { describe, expect, it, vi } from 'vitest';
import { SftpManager } from '../../src/sftp/SftpManager';
import type { TerminalContext } from '../../src/terminal/TerminalContext';

function context(connected: boolean, terminalId = 'terminal-a'): TerminalContext {
  return {
    terminalId,
    connected,
    write: vi.fn(),
    server: {
      id: 'srv',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 1
    }
  };
}

describe('SftpManager', () => {
  it('starts with no active state', () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('follows a connected terminal and resolves root lazily', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    expect(await manager.ensureRoot()).toBe('/home/deploy');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/deploy' });
  });

  it('changes the active root path through realpath', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async (path?: string) => (path === '/var/log' ? '/var/log' : '/home/deploy')),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    expect(await manager.changeDirectory('/var/log')).toBe('/var/log');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/var/log' });
  });

  it('keeps the current root when the same connected terminal is activated again', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async (path?: string) => (path === '/var/log' ? '/var/log' : '/home/deploy')),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    const activeContext = context(true);
    manager.setTerminalContext(activeContext);
    await manager.changeDirectory('/var/log');

    manager.setTerminalContext({ ...activeContext, write: vi.fn() });

    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/var/log' });
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('changes the active root path to the current parent directory', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async (path?: string) => path ?? '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));
    await manager.changeDirectory('/home/deploy/app');

    expect(await manager.changeToParentDirectory()).toBe('/home/deploy');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/deploy' });
  });

  it('keeps a disconnected snapshot', async () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    manager.setSnapshot('/home/deploy', [{ name: 'app', path: '/home/deploy/app', type: 'directory' }]);
    manager.setTerminalContext(context(false));

    expect(manager.getState()).toEqual({
      kind: 'disconnected',
      rootPath: '/home/deploy',
      entries: [{ name: 'app', path: '/home/deploy/app', type: 'directory' }]
    });
  });

  it('exposes the active connected server id for edit sessions', () => {
    const manager = new SftpManager({ createSession: vi.fn() });

    expect(manager.getActiveServerId()).toBeUndefined();

    manager.setTerminalContext(context(true));
    expect(manager.getActiveServerId()).toBe('srv');

    manager.setTerminalContext(context(false));
    expect(manager.getActiveServerId()).toBeUndefined();
  });

  it('reads remote file stat through the active SFTP session', async () => {
    const stat = vi.fn(async () => ({ size: 128, modifiedAt: 1714280000 }));
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat,
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await expect(manager.stat('/home/deploy/app.js')).resolves.toEqual({
      size: 128,
      modifiedAt: 1714280000
    });
    expect(stat).toHaveBeenCalledWith('/home/deploy/app.js');
  });

  it('creates a remote empty file through the active SFTP session', async () => {
    const createFile = vi.fn();
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile,
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.createFile('/home/deploy/new.txt');

    expect(createFile).toHaveBeenCalledWith('/home/deploy/new.txt');
  });

  it('passes transfer progress reporters to upload and download sessions', async () => {
    const uploadFile = vi.fn();
    const downloadFile = vi.fn();
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile,
      downloadFile,
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.uploadFile('C:\\Users\\alan\\Desktop\\docker-compose.yml', '/home/deploy/docker-compose.yml');
    await manager.downloadFile('/home/deploy/docker-compose.yml', 'C:\\Users\\alan\\Downloads\\docker-compose.yml');

    expect(uploadFile.mock.calls[0][2]).toHaveProperty('report');
    expect(downloadFile.mock.calls[0][2]).toHaveProperty('report');
  });

  it('waits for an in-flight SFTP connection before listing directories', async () => {
    const pendingConnect = deferred<void>();
    const session = {
      connect: vi.fn(() => pendingConnect.promise),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    const root = manager.ensureRoot();
    const entries = manager.listDirectory('/home/deploy');
    await flushPromises();

    expect(session.connect).toHaveBeenCalledTimes(1);
    expect(session.realpath).not.toHaveBeenCalled();
    expect(session.listDirectory).not.toHaveBeenCalled();

    pendingConnect.resolve();
    await expect(root).resolves.toBe('/home/deploy');
    await expect(entries).resolves.toEqual([]);
    expect(session.listDirectory).toHaveBeenCalledWith('/home/deploy');
  });

  it('does not reuse a stale SFTP connection after the active terminal changes', async () => {
    const firstConnect = deferred<void>();
    const firstSession = {
      connect: vi.fn(() => firstConnect.promise),
      realpath: vi.fn(async () => '/first'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const secondSession = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/second'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const createSession = vi.fn().mockReturnValueOnce(firstSession).mockReturnValueOnce(secondSession);
    const manager = new SftpManager({ createSession });

    manager.setTerminalContext(context(true, 'terminal-a'));
    const staleRoot = manager.ensureRoot();
    await flushPromises();
    manager.setTerminalContext(context(true, 'terminal-b'));
    firstConnect.resolve();

    await expect(staleRoot).rejects.toThrow('superseded');
    await expect(manager.ensureRoot()).resolves.toBe('/second');
    expect(firstSession.dispose).toHaveBeenCalled();
    expect(secondSession.realpath).toHaveBeenCalledWith('.');
  });

  it('rejects in-flight SFTP loads when the active terminal disconnects before connect settles', async () => {
    const firstConnect = deferred<void>();
    const firstSession = {
      connect: vi.fn(() => firstConnect.promise),
      realpath: vi.fn(async () => '/first'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const secondSession = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/second'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const createSession = vi.fn().mockReturnValueOnce(firstSession).mockReturnValueOnce(secondSession);
    const manager = new SftpManager({ createSession });

    manager.setTerminalContext(context(true, 'terminal-a'));
    const staleRoot = manager.ensureRoot();
    await flushPromises();

    manager.setTerminalContext(context(false, 'terminal-a'));
    await flushPromises();

    expect(await promiseState(staleRoot)).toBe('rejected');
    await expect(staleRoot).rejects.toThrow('superseded');
    expect(firstSession.dispose).toHaveBeenCalled();
    expect(firstSession.realpath).not.toHaveBeenCalled();

    manager.setTerminalContext(context(true, 'terminal-b'));
    await expect(manager.ensureRoot()).resolves.toBe('/second');
    expect(secondSession.realpath).toHaveBeenCalledWith('.');
  });

  it('disposes the active SFTP session and clears active state', async () => {
    const session = {
      connect: vi.fn(),
      realpath: vi.fn(async () => '/home/deploy'),
      listDirectory: vi.fn(async () => []),
      mkdir: vi.fn(),
      rename: vi.fn(),
      deleteFile: vi.fn(),
      deleteDirectory: vi.fn(),
      uploadFile: vi.fn(),
      downloadFile: vi.fn(),
      createFile: vi.fn(),
      stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
      dispose: vi.fn()
    };
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));
    await manager.ensureRoot();

    manager.dispose();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toEqual({ kind: 'none' });
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function promiseState<T>(promise: Promise<T>): Promise<'pending' | 'resolved' | 'rejected'> {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  promise.then(
    () => {
      state = 'resolved';
    },
    () => {
      state = 'rejected';
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return state;
}
