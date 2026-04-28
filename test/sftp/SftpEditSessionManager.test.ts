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
