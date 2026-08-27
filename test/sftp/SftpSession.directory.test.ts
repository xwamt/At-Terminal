import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIRECTORY_TRANSFER_CONCURRENCY, SftpSession } from '../../src/sftp/SftpSession';
import { SftpConflictError } from '../../src/sftp/SftpErrors';
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

interface FakeRow {
  filename: string;
  attrs: {
    size: number;
    mtime: number;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  };
}

function fileRow(filename: string, size = 0): FakeRow {
  return { filename, attrs: { size, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false } };
}

function dirRow(filename: string): FakeRow {
  return { filename, attrs: { size: 0, mtime: 1, isDirectory: () => true, isSymbolicLink: () => false } };
}

function symlinkRow(filename: string): FakeRow {
  return { filename, attrs: { size: 0, mtime: 1, isDirectory: () => false, isSymbolicLink: () => true } };
}

function readdirFromTree(tree: Record<string, FakeRow[]>) {
  return vi.fn((path: string, callback: (error?: Error, list?: FakeRow[]) => void) => {
    const rows = tree[path];
    if (!rows) {
      callback(new Error(`No such directory: ${path}`));
      return;
    }
    callback(undefined, rows);
  });
}

function noSuchFileStat() {
  return vi.fn((_path: string, callback: (error?: Error) => void) => {
    callback(Object.assign(new Error('No such file'), { code: 2 }));
  });
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

// Directory transfers interleave real fs work (threadpool) with mocked SFTP callbacks, so
// settling them needs several macrotask turns, not just a microtask drain.
async function flush(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('timed out waiting for SFTP directory transfer to progress');
}

describe('SftpSession downloadFile with a directory target', () => {
  it('cannot download a directory: fastGet fails like the server does', async () => {
    // Documents the gap downloadDirectory exists to fill: fastGet only handles regular files.
    const fastGet = vi.fn((_remote, _local, _options, callback) =>
      callback(new Error('Failure: /srv/site is a directory'))
    );
    const sftp = session({ fastGet });

    await expect(sftp.downloadFile('/srv/site', '/tmp/site')).rejects.toThrow('is a directory');
  });
});

describe('SftpSession downloadDirectory', () => {
  it('recreates the remote tree locally, following file symlinks but not directory symlinks', async () => {
    const localDir = await makeTempDir('sftp-download-');
    const tree: Record<string, FakeRow[]> = {
      '/srv/site': [fileRow('index.html', 5), dirRow('assets'), symlinkRow('link.txt'), symlinkRow('dirlink')],
      '/srv/site/assets': [fileRow('app.js', 10)]
    };
    const stat = vi.fn((path: string, callback: (error?: Error, stats?: unknown) => void) => {
      if (path === '/srv/site/dirlink') {
        callback(undefined, { size: 0, mtime: 1, isDirectory: () => true });
        return;
      }
      if (path === '/srv/site/link.txt') {
        callback(undefined, { size: 3, mtime: 1, isDirectory: () => false });
        return;
      }
      callback(new Error(`Unexpected stat: ${path}`));
    });
    const fastGet = vi.fn((remote: string, _local: string, options: { step?: Function }, callback: () => void) => {
      const size = remote.endsWith('app.js') ? 10 : remote.endsWith('index.html') ? 5 : 3;
      options.step?.(size, size, size);
      callback();
    });
    const reports: Array<{ transferredBytes: number; totalBytes: number }> = [];
    const sftp = session({ readdir: readdirFromTree(tree), stat, fastGet });

    await sftp.downloadDirectory('/srv/site', localDir, { report: (event) => reports.push(event) });

    const downloaded = fastGet.mock.calls.map((call) => call[0]).sort();
    expect(downloaded).toEqual(['/srv/site/assets/app.js', '/srv/site/index.html', '/srv/site/link.txt']);
    expect(fastGet.mock.calls.find((call) => call[0] === '/srv/site/assets/app.js')?.[1]).toBe(
      join(localDir, 'assets', 'app.js')
    );
    expect(existsSync(join(localDir, 'assets'))).toBe(true);
    expect(reports.at(-1)).toEqual({ transferredBytes: 18, totalBytes: 18 });
  });

  it('keeps at most four file downloads in flight', async () => {
    const localDir = await makeTempDir('sftp-download-concurrency-');
    const files = ['a', 'b', 'c', 'd', 'e', 'f'];
    const tree: Record<string, FakeRow[]> = {
      '/srv/data': files.map((name) => fileRow(`${name}.bin`, 1))
    };
    const pending: Array<() => void> = [];
    const fastGet = vi.fn((_remote, _local, _options, callback: () => void) => {
      pending.push(() => callback());
    });
    const sftp = session({ readdir: readdirFromTree(tree), fastGet });

    const done = sftp.downloadDirectory('/srv/data', localDir);
    await waitUntil(() => fastGet.mock.calls.length >= DIRECTORY_TRANSFER_CONCURRENCY);

    expect(fastGet).toHaveBeenCalledTimes(DIRECTORY_TRANSFER_CONCURRENCY);

    while (fastGet.mock.calls.length < files.length) {
      expect(pending.length).toBeGreaterThan(0);
      expect(pending.length).toBeLessThanOrEqual(DIRECTORY_TRANSFER_CONCURRENCY);
      pending.shift()!();
      await waitUntil(
        () => pending.length > 0 || fastGet.mock.calls.length === files.length
      );
    }
    while (pending.length > 0) {
      pending.shift()!();
    }
    await done;
    expect(fastGet).toHaveBeenCalledTimes(files.length);
  });
});

describe('SftpSession uploadDirectory', () => {
  it('creates remote directories parents-first and uploads every file with aggregated progress', async () => {
    const localDir = await makeTempDir('sftp-upload-');
    await writeFile(join(localDir, 'a.txt'), 'hello');
    await mkdir(join(localDir, 'nested'));
    await writeFile(join(localDir, 'nested', 'b.bin'), Buffer.alloc(10, 1));

    const mkdirCalls: string[] = [];
    const remoteMkdir = vi.fn((path: string, callback: (error?: Error) => void) => {
      mkdirCalls.push(path);
      callback();
    });
    const fastPut = vi.fn(
      (localPath: string, _remote: string, options: { step?: Function }, callback: () => void) => {
        const size = localPath.endsWith('a.txt') ? 5 : 10;
        options.step?.(size, size, size);
        callback();
      }
    );
    const reports: Array<{ transferredBytes: number; totalBytes: number }> = [];
    const sftp = session({ stat: noSuchFileStat(), mkdir: remoteMkdir, fastPut });

    await sftp.uploadDirectory(localDir, '/srv/dest', { report: (event) => reports.push(event) });

    expect(mkdirCalls).toEqual(['/srv/dest', '/srv/dest/nested']);
    const uploaded = fastPut.mock.calls.map((call) => call[1]).sort();
    expect(uploaded).toEqual(['/srv/dest/a.txt', '/srv/dest/nested/b.bin']);
    expect(reports.at(-1)).toEqual({ transferredBytes: 15, totalBytes: 15 });
  });

  it('raises a typed conflict when the remote directory already exists', async () => {
    const localDir = await makeTempDir('sftp-upload-conflict-');
    const stat = vi.fn((_path: string, callback: (error?: Error, stats?: unknown) => void) => {
      callback(undefined, { size: 0, mtime: 1, isDirectory: () => true });
    });
    const fastPut = vi.fn();
    const sftp = session({ stat, mkdir: vi.fn(), fastPut });

    const failure = await sftp.uploadDirectory(localDir, '/srv/dest').then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(SftpConflictError);
    expect((failure as SftpConflictError).path).toBe('/srv/dest');
    expect(fastPut).not.toHaveBeenCalled();
  });

  it('overwrites into an existing tree when explicitly allowed, tolerating existing directories', async () => {
    const localDir = await makeTempDir('sftp-upload-overwrite-');
    await writeFile(join(localDir, 'a.txt'), 'hello');
    const stat = vi.fn((_path: string, callback: (error?: Error, stats?: unknown) => void) => {
      callback(undefined, { size: 0, mtime: 1, isDirectory: () => true });
    });
    const remoteMkdir = vi.fn((_path: string, callback: (error?: Error) => void) => {
      callback(new Error('Failure: directory already exists'));
    });
    const fastPut = vi.fn((_local, _remote, _options, callback: () => void) => callback());
    const sftp = session({ stat, mkdir: remoteMkdir, fastPut });

    await sftp.uploadDirectory(localDir, '/srv/dest', undefined, { overwrite: true });

    expect(fastPut).toHaveBeenCalledWith(join(localDir, 'a.txt'), '/srv/dest/a.txt', expect.anything(), expect.any(Function));
  });
});

describe('SftpSession recursive delete', () => {
  it('deletes nested children before removing each directory', async () => {
    const tree: Record<string, FakeRow[]> = {
      '/srv/app': [dirRow('logs'), fileRow('a.txt', 3), symlinkRow('link')],
      '/srv/app/logs': [fileRow('x.log', 9)]
    };
    const operations: string[] = [];
    const unlink = vi.fn((path: string, callback: () => void) => {
      operations.push(`unlink ${path}`);
      callback();
    });
    const rmdir = vi.fn((path: string, callback: () => void) => {
      operations.push(`rmdir ${path}`);
      callback();
    });
    const sftp = session({ readdir: readdirFromTree(tree), unlink, rmdir });

    await sftp.deleteDirectory('/srv/app');

    expect(operations).toEqual([
      'unlink /srv/app/logs/x.log',
      'rmdir /srv/app/logs',
      'unlink /srv/app/a.txt',
      'unlink /srv/app/link',
      'rmdir /srv/app'
    ]);
  });

  it('counts every entry a recursive delete would remove, including the directory itself', async () => {
    const tree: Record<string, FakeRow[]> = {
      '/srv/app': [dirRow('logs'), fileRow('a.txt', 3), symlinkRow('link')],
      '/srv/app/logs': [fileRow('x.log', 9)]
    };
    const sftp = session({ readdir: readdirFromTree(tree) });

    await expect(sftp.countDeletableEntries('/srv/app')).resolves.toBe(5);
  });
});

describe('SftpSession symlink listing', () => {
  it('resolves symlink targets so directories stay expandable', async () => {
    const tree: Record<string, FakeRow[]> = {
      '/srv': [symlinkRow('dirlink'), symlinkRow('filelink'), symlinkRow('broken'), fileRow('plain.txt', 1)]
    };
    const stat = vi.fn((path: string, callback: (error?: Error, stats?: unknown) => void) => {
      if (path === '/srv/dirlink') {
        callback(undefined, { size: 0, mtime: 1, isDirectory: () => true });
        return;
      }
      if (path === '/srv/filelink') {
        callback(undefined, { size: 4, mtime: 1, isDirectory: () => false });
        return;
      }
      callback(new Error('No such file'));
    });
    const sftp = session({ readdir: readdirFromTree(tree), stat });

    const entries = await sftp.listDirectory('/srv');

    expect(entries.find((entry) => entry.name === 'dirlink')).toMatchObject({
      type: 'symlink',
      targetType: 'directory'
    });
    expect(entries.find((entry) => entry.name === 'filelink')).toMatchObject({
      type: 'symlink',
      targetType: 'file'
    });
    expect(entries.find((entry) => entry.name === 'broken')?.targetType).toBeUndefined();
    expect(entries.find((entry) => entry.name === 'plain.txt')).toMatchObject({ type: 'file' });
    expect(entries.find((entry) => entry.name === 'plain.txt')?.targetType).toBeUndefined();
  });
});
