import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState } from '../tree/SftpTreeProvider';
import type { SftpEntry } from './SftpTypes';

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
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
}
