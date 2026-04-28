import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { safePreviewName } from './RemotePath';

export const SFTP_PREVIEW_SCHEME = 'ssh-manager-sftp-preview';

export class SftpPreviewDocumentStore implements vscode.TextDocumentContentProvider {
  private readonly filesByUri = new Map<string, string>();

  createReadonlyUri(remotePath: string, localPath: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: SFTP_PREVIEW_SCHEME,
      path: `/${safePreviewName(remotePath)}`,
      query: encodeURIComponent(localPath)
    });
    this.filesByUri.set(uri.toString(), localPath);
    return uri;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const localPath = this.filesByUri.get(uri.toString());
    if (!localPath) {
      return '';
    }
    return readFile(localPath, 'utf8');
  }

  async deletePreviewFile(uri: vscode.Uri): Promise<void> {
    const localPath = this.filesByUri.get(uri.toString());
    if (!localPath) {
      return;
    }
    this.filesByUri.delete(uri.toString());
    await rm(localPath, { force: true });
  }
}

export interface OpenRemotePreviewFileOptions {
  storageUri: vscode.Uri;
  remotePath: string;
  previewStore: SftpPreviewDocumentStore;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  openUri(uri: vscode.Uri): Promise<void>;
}

export async function openRemotePreviewFile(options: OpenRemotePreviewFileOptions): Promise<vscode.Uri> {
  const localPreviewUri = vscode.Uri.joinPath(options.storageUri, 'sftp-preview', safePreviewName(options.remotePath));
  await mkdir(dirname(localPreviewUri.fsPath), { recursive: true });
  await options.downloadFile(options.remotePath, localPreviewUri.fsPath);
  const readonlyUri = options.previewStore.createReadonlyUri(options.remotePath, localPreviewUri.fsPath);
  await options.openUri(readonlyUri);
  return readonlyUri;
}
