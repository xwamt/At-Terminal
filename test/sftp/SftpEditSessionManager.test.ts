import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
  createVscodeSftpEditUi,
  resolveEditStorageUri,
  SftpEditSessionManager
} from '../../src/sftp/SftpEditSessionManager';

describe('SftpEditSessionManager open flow', () => {
  it('builds stable session keys and collision-resistant cache paths', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-test-')));
    try {
      expect(buildEditSessionKey('srv', '/etc/hosts')).toBe('srv:/etc/hosts');

      const first = createEditCacheUri(storage, 'srv', '/opt/a/config.json');
      const second = createEditCacheUri(storage, 'srv', '/opt/b/config.json');

      expect(first.fsPath).toContain('sftp-edit');
      expect(first.fsPath).toContain('srv');
      expect(first.fsPath).toContain('config.json');
      expect(second.fsPath).toContain('config.json');
      expect(first.fsPath).not.toBe(second.fsPath);
    } finally {
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('prefers workspace storage for editable caches so language extensions get workspace context', async () => {
    const globalStorage = vscode.Uri.file('C:/global-storage');
    const workspaceRoot = vscode.Uri.file('C:/project');

    const storage = resolveEditStorageUri(globalStorage, [
      { uri: workspaceRoot, name: 'project', index: 0 } as vscode.WorkspaceFolder
    ]);
    const cacheUri = createEditCacheUri(storage, 'srv', '/srv/app/test.py');

    expect(storage.fsPath).toContain('C:/project');
    expect(storage.fsPath).toContain('.ssh-terminal-manager');
    expect(cacheUri.fsPath).toContain('test.py');
    expect(cacheUri.fsPath).not.toContain('C:/global-storage');
  });

  it('falls back to extension storage when no file workspace is open', () => {
    const globalStorage = vscode.Uri.file('C:/global-storage');

    const storage = resolveEditStorageUri(globalStorage, []);

    expect(storage.fsPath).toBe(globalStorage.fsPath);
  });

  it('opens editable files outside VS Code preview tabs', async () => {
    const uri = vscode.Uri.file('C:/tmp/sftp-edit/file.txt');
    const document = { uri, fileName: uri.fsPath };
    const originalOpenTextDocument = vscode.workspace.openTextDocument;
    const originalShowTextDocument = vscode.window.showTextDocument;
    const openTextDocument = vi.fn(async () => document);
    const showTextDocument = vi.fn(async () => document);
    (vscode.workspace as unknown as { openTextDocument: typeof openTextDocument }).openTextDocument = openTextDocument;
    (vscode.window as unknown as { showTextDocument: typeof showTextDocument }).showTextDocument = showTextDocument;

    try {
      const ui = createVscodeSftpEditUi(vscode.window.createStatusBarItem());
      await ui.openFile(uri, '/tmp/file.txt');

      expect(openTextDocument).toHaveBeenCalledWith(uri);
      expect(showTextDocument).toHaveBeenCalledWith(document, { preview: false });
    } finally {
      (vscode.workspace as unknown as { openTextDocument: typeof originalOpenTextDocument }).openTextDocument =
        originalOpenTextDocument;
      (vscode.window as unknown as { showTextDocument: typeof originalShowTextDocument }).showTextDocument =
        originalShowTextDocument;
    }
  });

  it('restores the language mode from the remote filename when VS Code opens a cache file as plaintext', async () => {
    const uri = vscode.Uri.file('C:/tmp/sftp-edit/test.py');
    const document = { uri, fileName: uri.fsPath, languageId: 'plaintext' };
    const pythonDocument = { ...document, languageId: 'python' };
    const originalOpenTextDocument = vscode.workspace.openTextDocument;
    const originalSetTextDocumentLanguage = vscode.languages.setTextDocumentLanguage;
    const originalShowTextDocument = vscode.window.showTextDocument;
    const openTextDocument = vi.fn(async () => document);
    const setTextDocumentLanguage = vi.fn(async () => pythonDocument);
    const showTextDocument = vi.fn(async () => pythonDocument);
    (vscode.workspace as unknown as { openTextDocument: typeof openTextDocument }).openTextDocument = openTextDocument;
    (
      vscode.languages as unknown as { setTextDocumentLanguage: typeof setTextDocumentLanguage }
    ).setTextDocumentLanguage = setTextDocumentLanguage;
    (vscode.window as unknown as { showTextDocument: typeof showTextDocument }).showTextDocument = showTextDocument;

    try {
      const ui = createVscodeSftpEditUi(vscode.window.createStatusBarItem());
      await ui.openFile(uri, '/srv/app/test.py');

      expect(setTextDocumentLanguage).toHaveBeenCalledWith(document, 'python');
      expect(showTextDocument).toHaveBeenCalledWith(pythonDocument, { preview: false });
    } finally {
      (vscode.workspace as unknown as { openTextDocument: typeof originalOpenTextDocument }).openTextDocument =
        originalOpenTextDocument;
      (
        vscode.languages as unknown as { setTextDocumentLanguage: typeof originalSetTextDocumentLanguage }
      ).setTextDocumentLanguage = originalSetTextDocumentLanguage;
      (vscode.window as unknown as { showTextDocument: typeof originalShowTextDocument }).showTextDocument =
        originalShowTextDocument;
    }
  });

  it('downloads a remote file, opens the cached local file, and reuses duplicate sessions', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-open-')));
    const opened: vscode.Uri[] = [];
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => {
        await writeFile(localPath, 'initial');
      }),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: async (uri) => {
          opened.push(uri);
        },
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const first = await manager.openRemoteFile('/srv/app/index.js');
      const second = await manager.openRemoteFile('/srv/app/index.js');

      expect(first.localUri.fsPath).toBe(second.localUri.fsPath);
      expect(existsSync(first.localUri.fsPath)).toBe(true);
      expect(sftp.downloadFile).toHaveBeenCalledTimes(1);
      expect(sftp.stat).toHaveBeenCalledTimes(1);
      expect(opened).toEqual([first.localUri, first.localUri]);
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});

describe('SftpEditSessionManager save synchronization', () => {
  it('ignores unmanaged saved documents', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-unmanaged-')));
    const uploadFile = vi.fn();
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(),
        downloadFile: vi.fn(),
        uploadFile
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      await manager.handleSavedDocument({ uri: vscode.Uri.file(join(storage.fsPath, 'other.txt')), fileName: 'other.txt' });
      expect(uploadFile).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('asks once before enabling automatic upload and then uploads future saves quietly', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-save-')));
    const confirmAutoSync = vi.fn(async () => true);
    const showStatus = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 25,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync,
        resolveConflict: vi.fn(),
        showStatus,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await flushPromises();

      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await flushPromises();

      expect(confirmAutoSync).toHaveBeenCalledTimes(1);
      expect(sftp.uploadFile).toHaveBeenCalledTimes(2);
      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js');
      expect(showStatus).toHaveBeenCalledWith('uploading', 'Uploading remote file...');
      expect(showStatus).toHaveBeenCalledWith('idle', 'Remote file synced');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('coalesces rapid saves into one upload', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-debounce-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 50,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(50);

      expect(sftp.uploadFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});

describe('SftpEditSessionManager conflicts and failures', () => {
  it('prompts before overwriting when the remote stat changed', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-conflict-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi
        .fn()
        .mockResolvedValueOnce({ size: 7, modifiedAt: 10 })
        .mockResolvedValueOnce({ size: 8, modifiedAt: 11 })
        .mockResolvedValueOnce({ size: 9, modifiedAt: 12 }),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(async () => 'overwrite' as const),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await writeFile(session.localUri.fsPath, 'changed!!');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await flushPromises();

      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js');
      expect(session.baseRemoteStat).toEqual({ size: 9, modifiedAt: 12 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('keeps local edits and does not upload when conflict resolution is canceled', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-cancel-conflict-')));
    const showStatus = vi.fn();
    const showError = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn().mockResolvedValueOnce({ size: 7, modifiedAt: 10 }).mockResolvedValueOnce({ size: 8, modifiedAt: 11 }),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(async () => 'cancel' as const),
        showStatus,
        showError,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(sftp.uploadFile).not.toHaveBeenCalled();
      expect(session.syncState).toBe('failed');
      expect(showStatus).toHaveBeenCalledWith('conflict', 'Remote file changed');
      expect(showError).toHaveBeenCalledWith(
        '/srv/app/index.js',
        'Remote sync cancelled because /srv/app/index.js changed on the server.'
      );
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('does not advance the remote baseline when upload fails', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-failed-')));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(async () => {
        throw new Error('permission denied');
      })
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(session.syncState).toBe('failed');
      expect(session.lastError).toBe('permission denied');
      expect(session.baseRemoteStat).toEqual({ size: 7, modifiedAt: 10 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('reports an error when an upload succeeds but the remote content did not change', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-verify-failed-')));
    const showStatus = vi.fn();
    const showError = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(),
      readFile: vi.fn(async () => Buffer.from('initial'))
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus,
        showError,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await writeFile(session.localUri.fsPath, 'changed');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await flushPromises();

      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js');
      expect(sftp.readFile).toHaveBeenCalledWith('/srv/app/index.js', 7);
      expect(session.syncState).toBe('failed');
      expect(session.lastError).toContain('remote content does not match local edits');
      expect(showStatus).toHaveBeenCalledWith('failed', expect.stringContaining('remote content does not match'));
      expect(showError).toHaveBeenCalledWith('/srv/app/index.js', expect.stringContaining('remote content does not match'));
      expect(session.baseRemoteStat).toEqual({ size: 7, modifiedAt: 10 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('reports an error when the user declines remote sync after saving', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-sync-declined-')));
    const showError = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => false),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        showError,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);

      expect(sftp.uploadFile).not.toHaveBeenCalled();
      expect(session.syncState).toBe('failed');
      expect(showError).toHaveBeenCalledWith('/srv/app/index.js', 'Remote sync was not enabled. Save was not uploaded.');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SftpEditSessionManager close cleanup', () => {
  it('deletes cache and unregisters clean idle sessions on close', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-clean-')));
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
        downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
        uploadFile: vi.fn()
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('deletes cache and unregisters failed sessions on close without replacing the original error', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-failed-')));
    const showError = vi.fn();
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp: {
        getActiveServerId: vi.fn(() => 'srv'),
        stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
        downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
        uploadFile: vi.fn()
      },
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        showError,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      session.syncState = 'failed';
      session.lastError = 'permission denied';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(showError).not.toHaveBeenCalled();
      expect(session.lastError).toBe('permission denied');
      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('deletes cache on closed editor tabs so reopening downloads a fresh remote copy', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-tab-')));
    let remoteContent = 'initial';
    const opened: vscode.Uri[] = [];
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: remoteContent.length, modifiedAt: remoteContent.length })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, remoteContent)),
      uploadFile: vi.fn()
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: async (uri) => {
          opened.push(uri);
        },
        confirmAutoSync: vi.fn(),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const first = await manager.openRemoteFile('/srv/app/index.js');
      expect(existsSync(first.localUri.fsPath)).toBe(true);

      await manager.handleClosedTabs([{ input: { uri: first.localUri } } as vscode.Tab]);

      expect(existsSync(first.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(first.localUri.fsPath)).toBeUndefined();

      remoteContent = 'changed';
      const second = await manager.openRemoteFile('/srv/app/index.js');

      expect(second.localUri.fsPath).toBe(first.localUri.fsPath);
      expect(sftp.downloadFile).toHaveBeenCalledTimes(2);
      expect(opened).toEqual([first.localUri, second.localUri]);
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight upload before deleting cache on editor tab close', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-uploading-')));
    const upload = deferred<void>();
    const showError = vi.fn();
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(() => upload.promise)
    };
    const manager = new SftpEditSessionManager({
      storageUri: storage,
      sftp,
      debounceMs: 10,
      ui: {
        openFile: vi.fn(),
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        showError,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await flushPromises();

      const close = manager.handleClosedTabs([{ input: { uri: session.localUri } } as vscode.Tab]);
      await flushPromises();

      expect(session.syncState).toBe('uploading');
      expect(existsSync(session.localUri.fsPath)).toBe(true);
      expect(showError).not.toHaveBeenCalled();

      upload.resolve();
      await close;

      expect(session.syncState).toBe('idle');
      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
      expect(showError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
