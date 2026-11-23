import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname, extname } from 'node:path';
import * as vscode from 'vscode';
import { safePreviewName } from './RemotePath';

export const SFTP_PREVIEW_SCHEME = 'ssh-manager-sftp-preview';
/** Text previews above this size stall the SFTP channel and risk Extension Host OOM. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

const BINARY_PREVIEW_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bz2', '.class', '.dll', '.dmg', '.doc', '.docx', '.exe', '.gz',
  '.gzip', '.img', '.iso', '.jar', '.jpeg', '.jpg', '.mkv', '.mov', '.mp3', '.mp4', '.pdf',
  '.png', '.rar', '.so', '.tar', '.tgz', '.war', '.webm', '.webp', '.xls', '.xlsx', '.xz', '.zip'
]);

/** Opening was declined at the large/binary confirmation; callers should stay quiet. */
export class SftpPreviewCancelledError extends Error {
  constructor(readonly remotePath: string) {
    super(`Preview of ${remotePath} was cancelled.`);
    this.name = 'SftpPreviewCancelledError';
  }
}

export function isLikelyBinaryPreviewPath(remotePath: string): boolean {
  const lower = remotePath.toLowerCase();
  return [...BINARY_PREVIEW_EXTENSIONS].some((extension) => lower.endsWith(extension));
}

export class SftpPreviewDocumentStore implements vscode.TextDocumentContentProvider {
  private readonly filesByUri = new Map<string, string>();

  createReadonlyUri(remotePath: string, localPath: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: SFTP_PREVIEW_SCHEME,
      path: `/${safePreviewDocumentName(remotePath)}`,
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

  async deletePreviewFilesForClosedTabs(tabs: readonly vscode.Tab[]): Promise<void> {
    for (const tab of tabs) {
      const uri = getTabInputUri(tab);
      if (uri?.scheme === SFTP_PREVIEW_SCHEME) {
        await this.deletePreviewFile(uri);
      }
    }
  }
}

export interface OpenRemotePreviewFileOptions {
  storageUri: vscode.Uri;
  remotePath: string;
  previewStore: SftpPreviewDocumentStore;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  openUri(uri: vscode.Uri, options?: vscode.TextDocumentShowOptions): Promise<void>;
  /** Optional size probe; when present, oversized/binary files are confirmed before download. */
  statFile?(remotePath: string): Promise<{ size: number }>;
  confirmOpen?(remotePath: string, size: number, limitBytes: number): Promise<boolean>;
  maxBytes?: number;
}

export function safePreviewDocumentName(remotePath: string): string {
  const safeName = safePreviewName(remotePath)
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/g, '');
  const displayName = safeName || 'remote-file';
  return extname(displayName) ? displayName : `${displayName}.txt`;
}

export async function openRemotePreviewFile(
  options: OpenRemotePreviewFileOptions
): Promise<vscode.Uri> {
  const limitBytes = options.maxBytes ?? PREVIEW_MAX_BYTES;
  if (options.statFile) {
    const stats = await options.statFile(options.remotePath);
    const binary = isLikelyBinaryPreviewPath(options.remotePath);
    if (binary || stats.size > limitBytes) {
      const confirmed = options.confirmOpen
        ? await options.confirmOpen(options.remotePath, stats.size, limitBytes)
        : false;
      if (!confirmed) {
        throw new SftpPreviewCancelledError(options.remotePath);
      }
    }
  }

  const remoteHash = createHash('sha256').update(options.remotePath).digest('hex').slice(0, 16);
  const localPreviewUri = vscode.Uri.joinPath(
    options.storageUri,
    'sftp-preview',
    remoteHash,
    safePreviewDocumentName(options.remotePath)
  );
  await mkdir(dirname(localPreviewUri.fsPath), { recursive: true });
  await options.downloadFile(options.remotePath, localPreviewUri.fsPath);
  const readonlyUri = options.previewStore.createReadonlyUri(options.remotePath, localPreviewUri.fsPath);
  await options.openUri(readonlyUri, { preview: false });
  return readonlyUri;
}

function getTabInputUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (typeof input !== 'object' || input === null || !('uri' in input)) {
    return undefined;
  }
  const uri = (input as { uri?: unknown }).uri;
  return uri instanceof vscode.Uri ? uri : undefined;
}

/** Deletes the temporary preview cache; called from `deactivate()` as a best-effort sweep. */
export async function cleanupPreviewCache(storagePath: string): Promise<void> {
  await rm(join(storagePath, 'sftp-preview'), { recursive: true, force: true }).catch(() => undefined);
}
