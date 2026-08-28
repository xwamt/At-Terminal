import { afterEach, describe, expect, it, vi } from 'vitest';
import { LISTING_CACHE_TTL_MS, SftpManager, type SftpSessionLike } from '../../src/sftp/SftpManager';
import type { TransferReporter } from '../../src/sftp/TransferService';
import type { TerminalContext } from '../../src/terminal/TerminalContext';

function context(connected: boolean, terminalId = 'terminal-a', serverId = 'srv'): TerminalContext {
  return {
    terminalId,
    connected,
    write: vi.fn(),
    server: {
      id: serverId,
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

function sessionStub(overrides: Partial<SftpSessionLike> = {}): SftpSessionLike {
  return {
    connect: vi.fn(),
    realpath: vi.fn(async () => '/home/deploy'),
    listDirectory: vi.fn(async () => []),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    countDeletableEntries: vi.fn(async () => 0),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    uploadDirectory: vi.fn(),
    downloadDirectory: vi.fn(),
    createFile: vi.fn(),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
    dispose: vi.fn(),
    ...overrides
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SftpManager', () => {
  it('starts with no active state', () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    expect(manager.getState()).toEqual({ kind: 'none' });
  });

  it('follows a connected terminal and resolves root lazily', async () => {
    const session = sessionStub();
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    expect(await manager.ensureRoot()).toBe('/home/deploy');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/deploy' });
  });

  it('changes the active root path through realpath', async () => {
    const session = sessionStub({
      realpath: vi.fn(async (path?: string) => (path === '/var/log' ? '/var/log' : '/home/deploy'))
    });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    expect(await manager.changeDirectory('/var/log')).toBe('/var/log');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/var/log' });
  });

  it('keeps the current root when the same connected terminal is activated again', async () => {
    const session = sessionStub({
      realpath: vi.fn(async (path?: string) => (path === '/var/log' ? '/var/log' : '/home/deploy'))
    });
    const manager = new SftpManager({ createSession: () => session });
    const activeContext = context(true);
    manager.setTerminalContext(activeContext);
    await manager.changeDirectory('/var/log');

    manager.setTerminalContext({ ...activeContext, write: vi.fn() });

    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/var/log' });
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('changes the active root path to the current parent directory', async () => {
    const session = sessionStub({ realpath: vi.fn(async (path?: string) => path ?? '/home/deploy') });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));
    await manager.changeDirectory('/home/deploy/app');

    expect(await manager.changeToParentDirectory()).toBe('/home/deploy');
    expect(manager.getState()).toEqual({ kind: 'active', rootPath: '/home/deploy' });
  });

  it('keeps a disconnected snapshot', async () => {
    const manager = new SftpManager({ createSession: vi.fn() });
    manager.setTerminalContext(context(true));
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
    const session = sessionStub({ stat });
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
    const session = sessionStub({ createFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.createFile('/home/deploy/new.txt');

    expect(createFile).toHaveBeenCalledWith('/home/deploy/new.txt');
  });

  it('passes transfer progress reporters to upload and download sessions', async () => {
    const uploadFile = vi.fn();
    const downloadFile = vi.fn();
    const session = sessionStub({ uploadFile, downloadFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.uploadFile('C:\\Users\\alan\\Desktop\\docker-compose.yml', '/home/deploy/docker-compose.yml');
    await manager.downloadFile('/home/deploy/docker-compose.yml', 'C:\\Users\\alan\\Downloads\\docker-compose.yml');

    expect(uploadFile.mock.calls[0][2]).toHaveProperty('report');
    expect(downloadFile.mock.calls[0][2]).toHaveProperty('report');
  });

  it('passes the overwrite option through to the session upload', async () => {
    const uploadFile = vi.fn();
    const session = sessionStub({ uploadFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.uploadFile('/tmp/app.conf', '/home/deploy/app.conf', undefined, { overwrite: true });

    expect(uploadFile).toHaveBeenCalledWith(
      '/tmp/app.conf',
      '/home/deploy/app.conf',
      expect.objectContaining({ report: expect.any(Function) }),
      { overwrite: true }
    );
  });

  it('delegates recursive directory transfers to the session with aggregated progress', async () => {
    const uploadDirectory = vi.fn();
    const downloadDirectory = vi.fn();
    const session = sessionStub({ uploadDirectory, downloadDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.uploadDirectory('/tmp/site', '/home/deploy/site', undefined, { overwrite: true });
    await manager.downloadDirectory('/home/deploy/site', '/tmp/site-copy');

    expect(uploadDirectory).toHaveBeenCalledWith(
      '/tmp/site',
      '/home/deploy/site',
      expect.objectContaining({ report: expect.any(Function) }),
      { overwrite: true }
    );
    expect(downloadDirectory).toHaveBeenCalledWith(
      '/home/deploy/site',
      '/tmp/site-copy',
      expect.objectContaining({ report: expect.any(Function) })
    );
  });

  it('counts deletable entries through the session for delete confirmations', async () => {
    const countDeletableEntries = vi.fn(async () => 7);
    const session = sessionStub({ countDeletableEntries });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await expect(manager.countDeletableEntries('/home/deploy/logs')).resolves.toBe(7);
    expect(countDeletableEntries).toHaveBeenCalledWith('/home/deploy/logs');
  });

  it('deletes directories recursively through the session', async () => {
    const deleteDirectory = vi.fn();
    const deleteFile = vi.fn();
    const session = sessionStub({ deleteDirectory, deleteFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.deleteEntry({ name: 'logs', path: '/home/deploy/logs', type: 'directory' });
    await manager.deleteEntry({ name: 'link', path: '/home/deploy/link', type: 'symlink' });

    expect(deleteDirectory).toHaveBeenCalledWith('/home/deploy/logs');
    expect(deleteFile).toHaveBeenCalledWith('/home/deploy/link');
  });

  it('reads remote file content through the active SFTP session', async () => {
    const readFile = vi.fn(async () => Buffer.from('remote content'));
    const session = sessionStub({ readFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await expect(manager.readFile('/home/deploy/app.js', 1024)).resolves.toEqual(Buffer.from('remote content'));
    expect(readFile).toHaveBeenCalledWith('/home/deploy/app.js', 1024, 0);
  });

  it('passes a negative tail offset through to the session read', async () => {
    const readFile = vi.fn(async () => Buffer.from('tail'));
    const session = sessionStub({ readFile });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.readFile('/var/log/syslog', 4096, undefined, -4096);

    expect(readFile).toHaveBeenCalledWith('/var/log/syslog', 4096, -4096);
  });

  it('waits for an in-flight SFTP connection before listing directories', async () => {
    const pendingConnect = deferred<void>();
    const session = sessionStub({ connect: vi.fn(() => pendingConnect.promise) });
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

  it('keeps an existing SFTP connection alive when another terminal becomes active', async () => {
    const firstSession = sessionStub({ realpath: vi.fn(async () => '/first') });
    const secondSession = sessionStub({ realpath: vi.fn(async () => '/second') });
    const createSession = vi.fn().mockReturnValueOnce(firstSession).mockReturnValueOnce(secondSession);
    const manager = new SftpManager({ createSession });

    manager.setTerminalContext(context(true, 'terminal-a'));
    await expect(manager.ensureRoot()).resolves.toBe('/first');

    manager.setTerminalContext(context(true, 'terminal-b'));

    await expect(manager.ensureRoot()).resolves.toBe('/second');
    expect(firstSession.dispose).not.toHaveBeenCalled();
    expect(secondSession.realpath).toHaveBeenCalledWith('.');

    manager.setTerminalContext(context(true, 'terminal-a'));
    await expect(manager.ensureRoot()).resolves.toBe('/first');
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(firstSession.connect).toHaveBeenCalledTimes(1);
  });

  it('routes file operations to the connected SFTP session for the requested server', async () => {
    const firstSession = sessionStub({
      realpath: vi.fn(async () => '/first'),
      readFile: vi.fn(async () => Buffer.from('first')),
      stat: vi.fn(async () => ({ size: 5, modifiedAt: 1 }))
    });
    const secondSession = sessionStub({
      realpath: vi.fn(async () => '/second'),
      readFile: vi.fn(async () => Buffer.from('second')),
      stat: vi.fn(async () => ({ size: 6, modifiedAt: 2 }))
    });
    const createSession = vi.fn().mockReturnValueOnce(firstSession).mockReturnValueOnce(secondSession);
    const manager = new SftpManager({ createSession });
    manager.setTerminalContext(context(true, 'terminal-a', 'server-a'));
    await manager.ensureRoot();
    manager.setTerminalContext(context(true, 'terminal-b', 'server-b'));
    await manager.ensureRoot();

    await expect(manager.stat('/srv/app.js', 'server-a')).resolves.toEqual({ size: 5, modifiedAt: 1 });
    await expect(manager.readFile('/srv/app.js', 1024, 'server-a')).resolves.toEqual(Buffer.from('first'));

    expect(firstSession.stat).toHaveBeenCalledWith('/srv/app.js');
    expect(firstSession.readFile).toHaveBeenCalledWith('/srv/app.js', 1024, 0);
    expect(secondSession.stat).not.toHaveBeenCalledWith('/srv/app.js');
  });

  it('rejects in-flight SFTP loads when the active terminal disconnects before connect settles', async () => {
    const firstConnect = deferred<void>();
    const firstSession = sessionStub({
      connect: vi.fn(() => firstConnect.promise),
      realpath: vi.fn(async () => '/first')
    });
    const secondSession = sessionStub({ realpath: vi.fn(async () => '/second') });
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
    const session = sessionStub();
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));
    await manager.ensureRoot();

    manager.dispose();

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(manager.getState()).toEqual({ kind: 'none' });
  });
});

describe('SftpManager listing cache', () => {
  it('serves repeated listings from cache within the TTL and refetches after expiry', async () => {
    vi.useFakeTimers();
    const listDirectory = vi.fn(async () => [
      { name: 'app', path: '/home/deploy/app', type: 'directory' as const }
    ]);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy');
    await manager.listDirectory('/home/deploy');
    expect(listDirectory).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LISTING_CACHE_TTL_MS + 1);
    await manager.listDirectory('/home/deploy');
    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('caches per path', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy');
    await manager.listDirectory('/home/deploy/app');
    await manager.listDirectory('/home/deploy');

    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('invalidateAllListings drops every cached listing so an explicit refresh hits the server', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy');
    await manager.listDirectory('/home/deploy/app');
    manager.invalidateAllListings();
    await manager.listDirectory('/home/deploy');
    await manager.listDirectory('/home/deploy/app');

    expect(listDirectory).toHaveBeenCalledTimes(4);
  });

  it('caches per terminal', async () => {
    const firstList = vi.fn(async () => []);
    const secondList = vi.fn(async () => []);
    const createSession = vi
      .fn()
      .mockReturnValueOnce(sessionStub({ listDirectory: firstList }))
      .mockReturnValueOnce(sessionStub({ listDirectory: secondList }));
    const manager = new SftpManager({ createSession });

    manager.setTerminalContext(context(true, 'terminal-a'));
    await manager.listDirectory('/home/deploy');
    manager.setTerminalContext(context(true, 'terminal-b'));
    await manager.listDirectory('/home/deploy');

    expect(firstList).toHaveBeenCalledTimes(1);
    expect(secondList).toHaveBeenCalledTimes(1);
  });

  it('invalidates the parent listing when a child is created', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy');
    await manager.mkdir('/home/deploy/new-folder');
    await manager.listDirectory('/home/deploy');

    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('invalidates both old and new parents on rename', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy/from');
    await manager.listDirectory('/home/deploy/to');
    await manager.rename('/home/deploy/from/a.txt', '/home/deploy/to/a.txt');
    await manager.listDirectory('/home/deploy/from');
    await manager.listDirectory('/home/deploy/to');

    expect(listDirectory).toHaveBeenCalledTimes(4);
  });

  it('invalidates cached descendants when a directory tree changes', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy/site');
    await manager.listDirectory('/home/deploy/site/assets');
    await manager.deleteEntry({ name: 'site', path: '/home/deploy/site', type: 'directory' });
    await manager.listDirectory('/home/deploy/site');
    await manager.listDirectory('/home/deploy/site/assets');

    expect(listDirectory).toHaveBeenCalledTimes(4);
  });

  it('invalidates the target parent after uploads', async () => {
    const listDirectory = vi.fn(async () => []);
    const session = sessionStub({ listDirectory });
    const manager = new SftpManager({ createSession: () => session });
    manager.setTerminalContext(context(true));

    await manager.listDirectory('/home/deploy');
    await manager.uploadFile('/tmp/a.txt', '/home/deploy/a.txt');
    await manager.listDirectory('/home/deploy');

    expect(listDirectory).toHaveBeenCalledTimes(2);
  });

  it('does not serve cached listings after a terminal reconnects', async () => {
    const listDirectory = vi.fn(async () => []);
    const createSession = vi.fn(() => sessionStub({ listDirectory }));
    const manager = new SftpManager({ createSession });

    manager.setTerminalContext(context(true));
    await manager.listDirectory('/home/deploy');
    manager.setTerminalContext(context(false));
    manager.setTerminalContext(context(true));
    await manager.listDirectory('/home/deploy');

    expect(listDirectory).toHaveBeenCalledTimes(2);
  });
});

describe('SftpManager notifications', () => {
  function recordingReporter() {
    const successes: string[] = [];
    const failures: string[] = [];
    const progressLabels: string[] = [];
    const reporter: TransferReporter = {
      withProgress: async (label, task) => {
        progressLabels.push(label);
        return task({ report: () => undefined });
      },
      notifySuccess: async (message) => {
        successes.push(message);
      },
      notifyFailure: async (message) => {
        failures.push(message);
      }
    };
    return { reporter, successes, failures, progressLabels };
  }

  it('does not toast success or open progress for tiny metadata operations', async () => {
    const { reporter, successes, failures, progressLabels } = recordingReporter();
    const session = sessionStub();
    const manager = new SftpManager({ createSession: () => session, reporter });
    manager.setTerminalContext(context(true));

    await manager.mkdir('/home/deploy/dir');
    await manager.rename('/home/deploy/a', '/home/deploy/b');
    await manager.deleteEntry({ name: 'b', path: '/home/deploy/b', type: 'file' });
    await manager.createFile('/home/deploy/new.txt');

    expect(successes).toEqual([]);
    expect(progressLabels).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('still notifies failures for tiny metadata operations', async () => {
    const { reporter, failures } = recordingReporter();
    const session = sessionStub({
      mkdir: vi.fn(async () => {
        throw new Error('permission denied');
      })
    });
    const manager = new SftpManager({ createSession: () => session, reporter });
    manager.setTerminalContext(context(true));

    await expect(manager.mkdir('/etc/blocked')).rejects.toThrow('permission denied');
    expect(failures).toEqual(['new folder failed.']);
  });

  it('keeps progress and the success toast for real transfers', async () => {
    const { reporter, successes, progressLabels } = recordingReporter();
    const session = sessionStub();
    const manager = new SftpManager({ createSession: () => session, reporter });
    manager.setTerminalContext(context(true));

    await manager.uploadFile('/tmp/a.txt', '/home/deploy/a.txt');

    expect(progressLabels).toEqual(['Upload /home/deploy/a.txt']);
    expect(successes).toEqual(['Upload /home/deploy/a.txt completed.']);
  });
});

describe('SftpManager view descriptor', () => {
  it('describes the active terminal view for refresh skipping', async () => {
    const session = sessionStub();
    const manager = new SftpManager({ createSession: () => session });

    expect(manager.getActiveViewDescriptor()).toBeUndefined();

    manager.setTerminalContext(context(true, 'terminal-a'));
    expect(manager.getActiveViewDescriptor()).toEqual({
      terminalId: 'terminal-a',
      rootPath: undefined,
      connected: true
    });

    await manager.ensureRoot();
    expect(manager.getActiveViewDescriptor()).toEqual({
      terminalId: 'terminal-a',
      rootPath: '/home/deploy',
      connected: true
    });

    manager.setTerminalContext(context(false, 'terminal-a'));
    expect(manager.getActiveViewDescriptor()).toEqual({
      terminalId: 'terminal-a',
      rootPath: '/home/deploy',
      connected: false
    });
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
