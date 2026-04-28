import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState } from '../tree/SftpTreeProvider';
import { dirname } from './RemotePath';
import type { SftpEntry, SftpFileStat } from './SftpTypes';
import { TransferService, type TransferProgress, type TransferReporter } from './TransferService';

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string, progress?: TransferProgress): Promise<void>;
  downloadFile(remotePath: string, localPath: string, progress?: TransferProgress): Promise<void>;
  stat(path: string): Promise<SftpFileStat>;
  dispose(): void;
}

export interface SftpManagerOptions {
  createSession(context: TerminalContext): SftpSessionLike;
  reporter?: TransferReporter;
}

export class SftpManager {
  private terminalContext: TerminalContext | undefined;
  private session: SftpSessionLike | undefined;
  private connectingSession: SftpSessionLike | undefined;
  private connectingSessionPromise: Promise<SftpSessionLike> | undefined;
  private sessionGeneration = 0;
  private rootPath: string | undefined;
  private snapshot: { rootPath: string; entries: SftpEntry[] } | undefined;
  private readonly transfers: TransferService;

  constructor(private readonly options: SftpManagerOptions) {
    this.transfers = new TransferService(options.reporter);
  }

  setTerminalContext(context: TerminalContext | undefined): void {
    if (
      this.terminalContext &&
      context &&
      this.terminalContext.terminalId === context.terminalId &&
      this.terminalContext.connected === context.connected
    ) {
      this.terminalContext = context;
      return;
    }
    this.sessionGeneration++;
    this.connectingSession?.dispose();
    this.session?.dispose();
    this.connectingSession = undefined;
    this.connectingSessionPromise = undefined;
    this.session = undefined;
    this.terminalContext = context;
    if (!context?.connected) {
      return;
    }
    this.rootPath = undefined;
  }

  getState(): SftpTreeState {
    if (!this.terminalContext) {
      return { kind: 'none' };
    }
    if (!this.terminalContext.connected) {
      return this.snapshot
        ? { kind: 'disconnected', rootPath: this.snapshot.rootPath, entries: this.snapshot.entries }
        : { kind: 'none' };
    }
    return { kind: 'active', rootPath: this.rootPath ?? '.' };
  }

  getActiveServerId(): string | undefined {
    return this.terminalContext?.connected ? this.terminalContext.server.id : undefined;
  }

  async ensureRoot(): Promise<string> {
    const session = await this.ensureSession();
    this.rootPath = await session.realpath('.');
    return this.rootPath;
  }

  async listDirectory(path?: string): Promise<SftpEntry[]> {
    const root = this.rootPath ?? (await this.ensureRoot());
    const targetPath = path ?? root;
    const entries = await (await this.ensureSession()).listDirectory(targetPath);
    if (targetPath === root) {
      this.setSnapshot(root, entries);
    }
    return entries;
  }

  async changeDirectory(path: string): Promise<string> {
    const session = await this.ensureSession();
    this.rootPath = await session.realpath(path);
    return this.rootPath;
  }

  async changeToParentDirectory(): Promise<string> {
    const currentRoot = this.rootPath ?? (await this.ensureRoot());
    return this.changeDirectory(dirname(currentRoot));
  }

  async mkdir(path: string): Promise<void> {
    await this.runConnected('new folder', async (session) => session.mkdir(path));
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.runConnected('rename', async (session) => session.rename(oldPath, newPath));
  }

  async deleteEntry(entry: SftpEntry): Promise<void> {
    await this.runConnected('delete', async (session) => {
      if (entry.type === 'directory') {
        await session.deleteDirectory(entry.path);
        return;
      }
      await session.deleteFile(entry.path);
    });
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    await this.runConnected(`Upload ${remotePath}`, async (session, progress) =>
      session.uploadFile(localPath, remotePath, progress)
    );
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.runConnected(`Download ${remotePath}`, async (session, progress) =>
      session.downloadFile(remotePath, localPath, progress)
    );
  }

  async stat(path: string): Promise<SftpFileStat> {
    if (!this.terminalContext?.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    return await (await this.ensureSession()).stat(path);
  }

  setSnapshot(rootPath: string, entries: SftpEntry[]): void {
    this.snapshot = { rootPath, entries };
  }

  private async ensureSession(): Promise<SftpSessionLike> {
    const context = this.terminalContext;
    if (!context?.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    if (this.session) {
      return this.session;
    }
    if (this.connectingSessionPromise) {
      return await this.connectingSessionPromise;
    }

    const generation = this.sessionGeneration;
    const terminalId = context.terminalId;
    const session = this.options.createSession(context);
    this.connectingSession = session;
    const promise = Promise.resolve()
      .then(() => session.connect())
      .then(() => {
        if (
          generation !== this.sessionGeneration ||
          this.terminalContext?.terminalId !== terminalId ||
          !this.terminalContext.connected
        ) {
          throw new Error('SFTP connection was superseded by another active terminal.');
        }
        this.session = session;
        return session;
      })
      .catch((error) => {
        session.dispose();
        if (this.session === session) {
          this.session = undefined;
        }
        throw error;
      })
      .finally(() => {
        if (this.connectingSession === session) {
          this.connectingSession = undefined;
        }
        if (this.connectingSessionPromise === promise) {
          this.connectingSessionPromise = undefined;
        }
      });
    this.connectingSessionPromise = promise;
    return await promise;
  }

  private async runConnected<T>(
    label: string,
    job: (session: SftpSessionLike, progress: TransferProgress) => Promise<T>
  ): Promise<T> {
    await this.transfers.requireConnected(Boolean(this.terminalContext?.connected));
    return await this.transfers.run(label, async (progress) => {
      return await job(await this.ensureSession(), progress);
    });
  }
}
