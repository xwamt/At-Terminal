import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
  createVscodeSftpEditUi,
  resolveEditStorageUri,
  SftpEditSessionManager,
  VERIFY_FULL_CONTENT_MAX_BYTES
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

  it('keeps remote sync progress open until the upload job finishes', async () => {
    try {
      vi.useFakeTimers();
      let resolveJob!: (value: string) => void;
      const jobDone = new Promise<string>((resolve) => {
        resolveJob = resolve;
      });
      let progressTaskFinished = false;
      vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (options, task) => {
        if (options.title === 'Sync /srv/app/index.js') {
          const result = await task({ report: vi.fn() }, {} as never);
          progressTaskFinished = true;
          return result as never;
        }
        return (await task({ report: vi.fn() }, {} as never)) as never;
      });
      const ui = createVscodeSftpEditUi(vscode.window.createStatusBarItem());

      const pending = ui.withSyncProgress!('/srv/app/index.js', async () => await jobDone);
      await Promise.resolve();
      expect(progressTaskFinished).toBe(false);
      resolveJob('ok');
      await expect(pending).resolves.toBe('ok');
      expect(progressTaskFinished).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('reports a sync failure as an 8s toast without stalling the save that failed', async () => {
    try {
      vi.useFakeTimers();
      let toastDismissed = false;
      vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) => {
        await task({ report: vi.fn() }, {} as never);
        toastDismissed = true;
        return undefined as never;
      });
      const ui = createVscodeSftpEditUi(vscode.window.createStatusBarItem());
      let callerResumed = false;

      void ui.showError!('/srv/app/index.js', 'permission denied').then(() => {
        callerResumed = true;
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(callerResumed).toBe(true);
      expect(toastDismissed).toBe(false);
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(error) Remote sync failed for /srv/app/index.js: permission denied',
          cancellable: false
        },
        expect.any(Function)
      );

      await vi.advanceTimersByTimeAsync(7999);
      expect(toastDismissed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(toastDismissed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('leaves a clickable status bar entry that opens the kept local copy', () => {
    const statusBarItem = vscode.window.createStatusBarItem();
    const localUri = vscode.Uri.file('C:/tmp/sftp-edit/index.js');
    const ui = createVscodeSftpEditUi(statusBarItem);

    ui.showUnsyncedLocalCopy!('/srv/app/index.js', localUri);

    expect(statusBarItem.text).toContain('Unsynchronized remote edit');
    expect(statusBarItem.tooltip).toContain('/srv/app/index.js');
    expect(statusBarItem.tooltip).toContain(localUri.fsPath);
    expect(statusBarItem.command).toEqual({
      command: 'vscode.open',
      title: 'Open the unsynchronized local copy',
      arguments: [localUri]
    });
  });

  it('clears the recovery entry command once a later sync reports status', () => {
    const statusBarItem = vscode.window.createStatusBarItem();
    const ui = createVscodeSftpEditUi(statusBarItem);

    ui.showUnsyncedLocalCopy!('/srv/app/index.js', vscode.Uri.file('C:/tmp/sftp-edit/index.js'));
    ui.showStatus('uploading', 'Uploading remote file...');

    expect(statusBarItem.command).toBeUndefined();
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
    const withSyncProgressCalls: string[] = [];
    const showSuccess = vi.fn(async () => undefined);
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
        withSyncProgress: async <T>(remotePath: string, job: () => Promise<T>) => {
          withSyncProgressCalls.push(remotePath);
          return job();
        },
        showSuccess,
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await settleUpload(session);

      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);
      await settleUpload(session);

      expect(confirmAutoSync).toHaveBeenCalledTimes(1);
      expect(sftp.uploadFile).toHaveBeenCalledTimes(2);
      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js', 'srv', { overwrite: true });
      expect(showStatus).toHaveBeenCalledWith('uploading', 'Uploading remote file...');
      expect(showStatus).toHaveBeenCalledWith('idle', 'Remote file synced');
      expect(withSyncProgressCalls).toEqual(['/srv/app/index.js', '/srv/app/index.js']);
      expect(showSuccess).toHaveBeenCalledWith(
        '/srv/app/index.js',
        'Remote sync completed for /srv/app/index.js'
      );
      expect(showSuccess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('syncs saves through the server that opened the edit session even after active server changes', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-save-original-server-')));
    let activeServerId = 'server-a';
    const sftp = {
      getActiveServerId: vi.fn(() => activeServerId),
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
        confirmAutoSync: vi.fn(async () => true),
        resolveConflict: vi.fn(),
        showStatus: vi.fn(),
        promptUnsyncedClose: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      activeServerId = 'server-b';

      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await settleUpload(session);

      expect(sftp.stat).toHaveBeenCalledWith('/srv/app/index.js', 'server-a');
      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js', 'server-a', { overwrite: true });
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
      await settleUpload(session);

      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js', 'srv', { overwrite: true });
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
      await settleUpload(session);

      expect(sftp.uploadFile).toHaveBeenCalledWith(session.localUri.fsPath, '/srv/app/index.js', 'srv', { overwrite: true });
      expect(sftp.readFile).toHaveBeenCalledWith('/srv/app/index.js', 7, 'srv');
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

describe('SftpEditSessionManager upload verification', () => {
  it('skips the verification download when the upload moved the remote mtime forward', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-verify-mtime-')));
    const readRemote = vi.fn(async () => Buffer.from('changed'));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi
        .fn()
        .mockResolvedValueOnce({ size: 7, modifiedAt: 10 })
        .mockResolvedValueOnce({ size: 7, modifiedAt: 10 })
        .mockResolvedValueOnce({ size: 7, modifiedAt: 11 }),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(),
      readFile: readRemote
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
      await writeFile(session.localUri.fsPath, 'changed');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await settleUpload(session);

      expect(readRemote).not.toHaveBeenCalled();
      expect(session.syncState).toBe('idle');
      expect(session.baseRemoteStat).toEqual({ size: 7, modifiedAt: 11 });
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('skips the verification download for files larger than the full compare limit', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-verify-large-')));
    const large = 'x'.repeat(VERIFY_FULL_CONTENT_MAX_BYTES + 1);
    const readRemote = vi.fn(async () => Buffer.from(large));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: large.length, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, large)),
      uploadFile: vi.fn(),
      readFile: readRemote
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
      await settleUpload(session);

      expect(readRemote).not.toHaveBeenCalled();
      expect(session.syncState).toBe('idle');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('still compares bytes for a small file whose remote mtime did not move', async () => {
    vi.useFakeTimers();
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-verify-bytes-')));
    const readRemote = vi.fn(async () => Buffer.from('changed'));
    const sftp = {
      getActiveServerId: vi.fn(() => 'srv'),
      stat: vi.fn(async () => ({ size: 7, modifiedAt: 10 })),
      downloadFile: vi.fn(async (_remotePath: string, localPath: string) => writeFile(localPath, 'initial')),
      uploadFile: vi.fn(),
      readFile: readRemote
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
      await writeFile(session.localUri.fsPath, 'changed');
      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(10);
      await settleUpload(session);

      expect(readRemote).toHaveBeenCalledWith('/srv/app/index.js', 7, 'srv');
      expect(session.syncState).toBe('idle');
    } finally {
      vi.useRealTimers();
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('never reads the cache file synchronously, because that blocks the extension host', () => {
    const source = readFileSync('src/sftp/SftpEditSessionManager.ts', 'utf8');

    expect(source).not.toContain('readFileSync');
    expect(source).toContain("from 'node:fs/promises'");
  });

  it('sizes the local file with fs.stat before deciding whether to read it for a byte compare', () => {
    // Slurping the local file just to learn its length would buffer arbitrarily large files
    // on every save; the stat must come first and gate the read.
    const source = readFileSync('src/sftp/SftpEditSessionManager.ts', 'utf8');
    const statIndex = source.indexOf('await stat(session.localUri.fsPath)');
    const readIndex = source.indexOf('await readFile(session.localUri.fsPath)');

    expect(statIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(-1);
    expect(statIndex).toBeLessThan(readIndex);
  });
});

// The upload path awaits real filesystem reads, so settling it needs event loop turns and
// not just microtask drains. advanceTimersByTimeAsync yields through the unfaked timer.
async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

// Waits for the whole upload drain instead of guessing how many ticks it needs.
async function settleUpload(session: { uploadTask: Promise<void> | undefined }): Promise<void> {
  for (let turn = 0; turn < 20 && session.uploadTask; turn += 1) {
    await session.uploadTask;
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('SftpEditSessionManager close cleanup', () => {
  it('deletes cache and unregisters clean idle sessions on close without asking', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-clean-')));
    const promptUnsyncedClose = vi.fn();
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
        promptUnsyncedClose
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(promptUnsyncedClose).not.toHaveBeenCalled();
      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  // Superseded the assertion that a failed session's cache is deleted on close. That
  // assertion described the bug: an upload that failed on permissions, a dropped link, or a
  // cancelled conflict left the only copy of the user's edits in the cache file, and close
  // deleted it with rm(force). Closing an editor is not consent to discard unsaved work.
  it('keeps the cached file and offers a recovery entry when the user keeps an unsynchronized edit', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-failed-keep-')));
    const showError = vi.fn();
    const promptUnsyncedClose = vi.fn(async () => 'keep' as const);
    const showUnsyncedLocalCopy = vi.fn();
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
        promptUnsyncedClose,
        showUnsyncedLocalCopy
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      await writeFile(session.localUri.fsPath, 'edits that never reached the server');
      session.syncState = 'failed';
      session.lastError = 'permission denied';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(promptUnsyncedClose).toHaveBeenCalledWith('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);
      expect(await readFile(session.localUri.fsPath, 'utf8')).toBe('edits that never reached the server');
      expect(showUnsyncedLocalCopy).toHaveBeenCalledWith('/srv/app/index.js', session.localUri);
      expect(showError).not.toHaveBeenCalled();
      expect(session.lastError).toBe('permission denied');
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('deletes the cached file when the user discards an unsynchronized edit', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-failed-discard-')));
    const promptUnsyncedClose = vi.fn(async () => 'discard' as const);
    const showUnsyncedLocalCopy = vi.fn();
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
        promptUnsyncedClose,
        showUnsyncedLocalCopy
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      session.syncState = 'failed';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(promptUnsyncedClose).toHaveBeenCalledWith('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(false);
      expect(showUnsyncedLocalCopy).not.toHaveBeenCalled();
      expect(manager.getSessionByLocalPath(session.localUri.fsPath)).toBeUndefined();
    } finally {
      manager.dispose();
      await rm(storage.fsPath, { recursive: true, force: true });
    }
  });

  it('prompts for a conflicted session after recording why the close interrupted the sync', async () => {
    const storage = vscode.Uri.file(await mkdtemp(join(tmpdir(), 'sftp-edit-close-conflict-')));
    const showError = vi.fn();
    const promptUnsyncedClose = vi.fn(async () => 'keep' as const);
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
        promptUnsyncedClose,
        showUnsyncedLocalCopy: vi.fn()
      }
    });

    try {
      const session = await manager.openRemoteFile('/srv/app/index.js');
      session.syncState = 'conflict';

      await manager.handleClosedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });

      expect(session.lastError).toBe('Remote sync did not complete before the editor was closed.');
      expect(promptUnsyncedClose).toHaveBeenCalledWith('/srv/app/index.js');
      expect(existsSync(session.localUri.fsPath)).toBe(true);
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
