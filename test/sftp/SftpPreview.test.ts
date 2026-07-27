import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
  SFTP_PREVIEW_SCHEME,
  SftpPreviewDocumentStore,
  openRemotePreviewFile,
  safePreviewDocumentName
} from '../../src/sftp/SftpPreview';

describe('SftpPreview', () => {
  it('creates the preview directory before downloading and opens the cached file', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'sftp-preview-test-'));
    const opened: unknown[][] = [];
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
        openUri: async (...args: unknown[]) => {
          opened.push(args);
        }
      });

      expect(previewUri.scheme).toBe(SFTP_PREVIEW_SCHEME);
      expect(downloadedLocalPath).toContain('sftp-preview');
      expect(downloadedLocalPath).toContain('docker-compose.yml');
      expect(opened).toEqual([[previewUri, { preview: false }]]);
      expect(await previewStore.provideTextDocumentContent(previewUri)).toBe('services:\n');

      await previewStore.deletePreviewFile(previewUri);
      expect(existsSync(downloadedLocalPath)).toBe(false);
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });

  it('uses text-friendly preview names for Linux config files without Windows-style extensions', () => {
    expect(safePreviewDocumentName('/etc/crontab')).toBe('crontab.txt');
    expect(safePreviewDocumentName('/etc/.d')).toBe('_d.txt');
    expect(safePreviewDocumentName('/srv/app/docker-compose.yml')).toBe('docker-compose.yml');
  });

  it('uses remote-path-specific cache locations for same-named files', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'sftp-preview-hash-test-'));
    const previewStore = new SftpPreviewDocumentStore();
    const localPaths: string[] = [];

    try {
      const first = await openRemotePreviewFile({
        storageUri: vscode.Uri.file(storagePath),
        remotePath: '/etc/crontab',
        previewStore,
        downloadFile: async (_remotePath, localPath) => {
          localPaths.push(localPath);
          await writeFile(localPath, 'first\n');
        },
        openUri: async () => undefined
      });
      const second = await openRemotePreviewFile({
        storageUri: vscode.Uri.file(storagePath),
        remotePath: '/var/spool/cron/crontab',
        previewStore,
        downloadFile: async (_remotePath, localPath) => {
          localPaths.push(localPath);
          await writeFile(localPath, 'second\n');
        },
        openUri: async () => undefined
      });

      expect(first.path).toBe('/crontab.txt');
      expect(second.path).toBe('/crontab.txt');
      expect(localPaths[0]).not.toBe(localPaths[1]);
      expect(await previewStore.provideTextDocumentContent(first)).toBe('first\n');
      expect(await previewStore.provideTextDocumentContent(second)).toBe('second\n');
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });

  it('deletes cached preview files when their editor tabs are closed', async () => {
    const storagePath = await mkdtemp(join(tmpdir(), 'sftp-preview-close-tab-'));
    const previewStore = new SftpPreviewDocumentStore();
    let downloadedLocalPath = '';

    try {
      const previewUri = await openRemotePreviewFile({
        storageUri: vscode.Uri.file(storagePath),
        remotePath: '/etc/hosts',
        previewStore,
        downloadFile: async (_remotePath, localPath) => {
          downloadedLocalPath = localPath;
          await writeFile(localPath, '127.0.0.1 localhost\n');
        },
        openUri: async () => undefined
      });

      expect(existsSync(downloadedLocalPath)).toBe(true);

      await previewStore.deletePreviewFilesForClosedTabs([{ input: { uri: previewUri } } as vscode.Tab]);

      expect(existsSync(downloadedLocalPath)).toBe(false);
      expect(await previewStore.provideTextDocumentContent(previewUri)).toBe('');
    } finally {
      await rm(storagePath, { recursive: true, force: true });
    }
  });
});
