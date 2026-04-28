import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState } from '../tree/SftpTreeProvider';
import type { SftpEntry } from './SftpTypes';
import { TransferService } from './TransferService';

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  dispose(): void;
}

export interface SftpManagerOptions {
  createSession(context: TerminalContext): SftpSessionLike;
}

export class SftpManager {
  private terminalContext: TerminalContext | undefined;
  private session: SftpSessionLike | undefined;
  private rootPath: string | undefined;
  private snapshot: { rootPath: string; entries: SftpEntry[] } | undefined;
  private readonly transfers = new TransferService();

  constructor(private readonly options: SftpManagerOptions) {}

  setTerminalContext(context: TerminalContext | undefined): void {
    this.terminalContext = context;
    if (!context?.connected) {
      this.session?.dispose();
      this.session = undefined;
      return;
    }
    this.rootPath = undefined;
    this.session?.dispose();
    this.session = undefined;
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
    await this.runConnected('upload', async (session) => session.uploadFile(localPath, remotePath));
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    await this.runConnected('download', async (session) => session.downloadFile(remotePath, localPath));
  }

  setSnapshot(rootPath: string, entries: SftpEntry[]): void {
    this.snapshot = { rootPath, entries };
  }

  private async ensureSession(): Promise<SftpSessionLike> {
    if (!this.terminalContext?.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    if (!this.session) {
      this.session = this.options.createSession(this.terminalContext);
      await this.session.connect();
    }
    return this.session;
  }

  private async runConnected(label: string, job: (session: SftpSessionLike) => Promise<void>): Promise<void> {
    await this.transfers.requireConnected(Boolean(this.terminalContext?.connected));
    await this.transfers.run(label, async () => {
      await job(await this.ensureSession());
    });
  }
}
