import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { safePreviewName } from './RemotePath';
import type { SftpFileStat } from './SftpTypes';

export type SftpEditSyncState = 'idle' | 'pending' | 'uploading' | 'conflict' | 'failed';
export type SftpEditConflictChoice = 'overwrite' | 'cancel';
export type SftpEditCloseChoice = 'keep' | 'discard';

export interface SftpEditSftpClient {
  getActiveServerId(): string | undefined;
  stat(remotePath: string): Promise<SftpFileStat>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
}

export interface SftpEditUi {
  openFile(uri: vscode.Uri): Promise<void>;
  confirmAutoSync(remotePath: string): Promise<boolean>;
  resolveConflict(remotePath: string): Promise<SftpEditConflictChoice>;
  showStatus(state: SftpEditSyncState, message: string): void;
  promptUnsyncedClose(remotePath: string): Promise<SftpEditCloseChoice>;
}

export interface SftpEditSession {
  key: string;
  serverId: string;
  remotePath: string;
  localUri: vscode.Uri;
  baseRemoteStat: SftpFileStat;
  firstSaveConfirmed: boolean;
  syncState: SftpEditSyncState;
  uploadInProgress: boolean;
  pendingUpload: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | undefined;
  lastError: string | undefined;
}

export interface SftpEditSessionManagerOptions {
  storageUri: vscode.Uri;
  sftp: SftpEditSftpClient;
  ui: SftpEditUi;
  debounceMs?: number;
}

export function buildEditSessionKey(serverId: string, remotePath: string): string {
  return `${serverId}:${remotePath}`;
}

export function createEditCacheUri(storageUri: vscode.Uri, serverId: string, remotePath: string): vscode.Uri {
  const hash = createHash('sha256').update(remotePath).digest('hex').slice(0, 16);
  return vscode.Uri.joinPath(storageUri, 'sftp-edit', safePreviewName(serverId), hash, safePreviewName(remotePath));
}

export function remoteStatsMatch(left: SftpFileStat, right: SftpFileStat): boolean {
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export class SftpEditSessionManager {
  private readonly sessionsByKey = new Map<string, SftpEditSession>();
  private readonly sessionsByLocalPath = new Map<string, SftpEditSession>();
  private readonly debounceMs: number;

  constructor(private readonly options: SftpEditSessionManagerOptions) {
    this.debounceMs = options.debounceMs ?? 750;
  }

  async openRemoteFile(remotePath: string): Promise<SftpEditSession> {
    const serverId = this.options.sftp.getActiveServerId();
    if (!serverId) {
      throw new Error('No connected SSH terminal is active.');
    }

    const key = buildEditSessionKey(serverId, remotePath);
    const existing = this.sessionsByKey.get(key);
    if (existing) {
      await this.options.ui.openFile(existing.localUri);
      return existing;
    }

    const localUri = createEditCacheUri(this.options.storageUri, serverId, remotePath);
    await mkdir(dirname(localUri.fsPath), { recursive: true });
    const baseRemoteStat = await this.options.sftp.stat(remotePath);
    await this.options.sftp.downloadFile(remotePath, localUri.fsPath);

    const session: SftpEditSession = {
      key,
      serverId,
      remotePath,
      localUri,
      baseRemoteStat,
      firstSaveConfirmed: false,
      syncState: 'idle',
      uploadInProgress: false,
      pendingUpload: false,
      debounceTimer: undefined,
      lastError: undefined
    };
    this.sessionsByKey.set(key, session);
    this.sessionsByLocalPath.set(localUri.fsPath, session);
    await this.options.ui.openFile(localUri);
    return session;
  }

  getSessionByLocalPath(localPath: string): SftpEditSession | undefined {
    return this.sessionsByLocalPath.get(localPath);
  }

  async handleSavedDocument(document: Pick<vscode.TextDocument, 'uri'> & { fileName?: string }): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
    this.scheduleUpload(session);
  }

  dispose(): void {
    for (const session of this.sessionsByKey.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
    this.sessionsByKey.clear();
    this.sessionsByLocalPath.clear();
  }

  async deleteSessionCache(session: SftpEditSession): Promise<void> {
    await rm(session.localUri.fsPath, { force: true });
  }

  private scheduleUpload(session: SftpEditSession): void {
    session.syncState = 'pending';
    session.pendingUpload = true;
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
    }
    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = undefined;
      void this.drainUploadQueue(session);
    }, this.debounceMs);
  }

  private async drainUploadQueue(session: SftpEditSession): Promise<void> {
    if (session.uploadInProgress) {
      session.pendingUpload = true;
      return;
    }

    while (session.pendingUpload) {
      session.pendingUpload = false;
      if (!session.firstSaveConfirmed) {
        const confirmed = await this.options.ui.confirmAutoSync(session.remotePath);
        if (!confirmed) {
          session.syncState = 'idle';
          return;
        }
        session.firstSaveConfirmed = true;
      }

      session.uploadInProgress = true;
      session.syncState = 'uploading';
      session.lastError = undefined;
      this.options.ui.showStatus('uploading', 'Uploading remote file...');
      try {
        const uploaded = await this.uploadIfUnchanged(session);
        if (!uploaded) {
          return;
        }
        session.syncState = 'idle';
        this.options.ui.showStatus('idle', 'Remote file synced');
      } catch (error) {
        session.syncState = 'failed';
        session.lastError = error instanceof Error ? error.message : String(error);
        this.options.ui.showStatus('failed', 'Remote sync failed');
      } finally {
        session.uploadInProgress = false;
      }
    }
  }

  private async uploadIfUnchanged(session: SftpEditSession): Promise<boolean> {
    const currentRemoteStat = await this.options.sftp.stat(session.remotePath);
    if (!remoteStatsMatch(currentRemoteStat, session.baseRemoteStat)) {
      session.syncState = 'conflict';
      this.options.ui.showStatus('conflict', 'Remote file changed');
      return false;
    }
    await this.options.sftp.uploadFile(session.localUri.fsPath, session.remotePath);
    session.baseRemoteStat = await this.options.sftp.stat(session.remotePath);
    return true;
  }
}
