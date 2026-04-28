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
  openFile(uri: vscode.Uri, remotePath: string): Promise<void>;
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

export function resolveEditStorageUri(
  globalStorageUri: vscode.Uri,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined
): vscode.Uri {
  const fileWorkspace = workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
  return fileWorkspace ? vscode.Uri.joinPath(fileWorkspace.uri, '.ssh-terminal-manager') : globalStorageUri;
}

export function remoteStatsMatch(left: SftpFileStat, right: SftpFileStat): boolean {
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

export class SftpEditSessionManager {
  private readonly sessionsByKey = new Map<string, SftpEditSession>();
  private readonly sessionsByLocalPath = new Map<string, SftpEditSession>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly debounceMs: number;

  constructor(private readonly options: SftpEditSessionManagerOptions) {
    this.debounceMs = options.debounceMs ?? 750;
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.handleSavedDocument(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        void this.handleClosedDocument(document);
      })
    );
  }

  async openRemoteFile(remotePath: string): Promise<SftpEditSession> {
    const serverId = this.options.sftp.getActiveServerId();
    if (!serverId) {
      throw new Error('No connected SSH terminal is active.');
    }

    const key = buildEditSessionKey(serverId, remotePath);
    const existing = this.sessionsByKey.get(key);
    if (existing) {
      await this.options.ui.openFile(existing.localUri, existing.remotePath);
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
    await this.options.ui.openFile(localUri, remotePath);
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

  async handleClosedDocument(document: Pick<vscode.TextDocument, 'uri'> & { fileName?: string }): Promise<void> {
    const session = this.sessionsByLocalPath.get(document.uri.fsPath);
    if (!session) {
      return;
    }
    if (this.hasUnsynchronizedState(session)) {
      const choice = await this.options.ui.promptUnsyncedClose(session.remotePath);
      if (choice === 'keep') {
        return;
      }
    }

    this.unregisterSession(session);
    await this.deleteSessionCache(session);
  }

  dispose(): void {
    for (const session of this.sessionsByKey.values()) {
      if (session.debounceTimer) {
        clearTimeout(session.debounceTimer);
      }
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.sessionsByKey.clear();
    this.sessionsByLocalPath.clear();
  }

  async deleteSessionCache(session: SftpEditSession): Promise<void> {
    await rm(session.localUri.fsPath, { force: true });
  }

  private hasUnsynchronizedState(session: SftpEditSession): boolean {
    return (
      session.syncState === 'pending' ||
      session.syncState === 'uploading' ||
      session.syncState === 'conflict' ||
      session.syncState === 'failed'
    );
  }

  private unregisterSession(session: SftpEditSession): void {
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer);
      session.debounceTimer = undefined;
    }
    this.sessionsByKey.delete(session.key);
    this.sessionsByLocalPath.delete(session.localUri.fsPath);
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
    const conflict = !remoteStatsMatch(currentRemoteStat, session.baseRemoteStat);
    if (conflict) {
      session.syncState = 'conflict';
      this.options.ui.showStatus('conflict', 'Remote file changed');
      const choice = await this.options.ui.resolveConflict(session.remotePath);
      if (choice === 'cancel') {
        return false;
      }
      session.syncState = 'uploading';
    }
    await this.options.sftp.uploadFile(session.localUri.fsPath, session.remotePath);
    session.baseRemoteStat = await this.options.sftp.stat(session.remotePath);
    return true;
  }
}

export function createVscodeSftpEditUi(statusBarItem: vscode.StatusBarItem): SftpEditUi {
  return {
    async openFile(uri, remotePath) {
      const document = await vscode.workspace.openTextDocument(uri);
      const languageId = inferLanguageId(remotePath);
      const visibleDocument =
        languageId && document.languageId === 'plaintext'
          ? await vscode.languages.setTextDocumentLanguage(document, languageId)
          : document;
      await vscode.window.showTextDocument(visibleDocument, { preview: false });
    },
    async confirmAutoSync(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Enable automatic sync to ${remotePath} for this edit session?`,
        { modal: true },
        'Enable Sync'
      );
      return answer === 'Enable Sync';
    },
    async resolveConflict(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Remote file changed: ${remotePath}`,
        { modal: true },
        'Overwrite Remote',
        'Cancel Upload'
      );
      return answer === 'Overwrite Remote' ? 'overwrite' : 'cancel';
    },
    showStatus(state, message) {
      statusBarItem.text =
        state === 'uploading'
          ? '$(sync~spin) Uploading remote file...'
          : state === 'idle'
            ? '$(check) Remote file synced'
            : state === 'conflict'
              ? '$(warning) Remote file changed'
              : '$(error) Remote sync failed';
      statusBarItem.tooltip = message;
      statusBarItem.show();
      if (state === 'idle') {
        setTimeout(() => statusBarItem.hide(), 2000);
      }
    },
    async promptUnsyncedClose(remotePath) {
      const answer = await vscode.window.showWarningMessage(
        `Remote edit has unsynchronized changes: ${remotePath}`,
        { modal: true },
        'Keep Local Copy',
        'Discard Local Copy'
      );
      return answer === 'Discard Local Copy' ? 'discard' : 'keep';
    }
  };
}

function inferLanguageId(remotePath: string): string | undefined {
  const lowerName = safePreviewName(remotePath).toLowerCase();
  if (lowerName === 'dockerfile' || lowerName.endsWith('.dockerfile')) {
    return 'dockerfile';
  }
  if (lowerName === 'makefile') {
    return 'makefile';
  }

  const extension = lowerName.match(/\.([^.]+)$/)?.[1];
  if (!extension) {
    return undefined;
  }

  const languagesByExtension: Record<string, string> = {
    bash: 'shellscript',
    c: 'c',
    cc: 'cpp',
    conf: 'properties',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    h: 'c',
    hpp: 'cpp',
    html: 'html',
    ini: 'ini',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascriptreact',
    lua: 'lua',
    md: 'markdown',
    php: 'php',
    ps1: 'powershell',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    scss: 'scss',
    sh: 'shellscript',
    sql: 'sql',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'typescriptreact',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zsh: 'shellscript'
  };
  return languagesByExtension[extension];
}
