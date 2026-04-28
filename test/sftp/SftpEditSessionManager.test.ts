import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  buildEditSessionKey,
  createEditCacheUri,
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

      await manager.handleSavedDocument({ uri: session.localUri, fileName: session.localUri.fsPath });
      await vi.advanceTimersByTimeAsync(25);

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
