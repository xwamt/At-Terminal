import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { SFTP_PREVIEW_SCHEME, SftpPreviewDocumentStore, openRemotePreviewFile } from '../../src/sftp/SftpPreview';

describe('SftpPreview', () => {
  it('creates the preview directory before downloading and opens the cached file', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'sftp-preview-test-'));
    const opened: vscode.Uri[] = [];
    let downloadedLocalPath = '';
    const previewStore = new SftpPreviewDocumentStore();

    try {
      const previewUri = await openRemotePreviewFile({
        storageUri: vscode.Uri.file(storagePath),
        remotePath: '/srv/app/docker-compose.yml',
        previewStore,
        downloadFile: async (_remotePath, localPath) => {
          downloadedLocalPath = localPath;
          expect(existsSync(dirname(localPath))).toBe(true);
          await writeFile(localPath, 'services:\n');
        },
        openUri: async (uri) => {
          opened.push(uri);
        }
      });

      expect(previewUri.scheme).toBe(SFTP_PREVIEW_SCHEME);
      expect(downloadedLocalPath).toContain('sftp-preview');
      expect(downloadedLocalPath).toContain('docker-compose.yml');
      expect(opened).toEqual([previewUri]);
      expect(await previewStore.provideTextDocumentContent(previewUri)).toBe('services:\n');

      await previewStore.deletePreviewFile(previewUri);
      expect(existsSync(downloadedLocalPath)).toBe(false);
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });
});
