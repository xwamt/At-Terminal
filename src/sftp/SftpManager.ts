import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState } from '../tree/SftpTreeProvider';
import { dirname } from './RemotePath';
import type { SftpEntry, SftpFileStat } from './SftpTypes';
import { TransferService, type TransferProgress, type TransferReporter } from './TransferService';

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  readFile(path: string, maxBytes: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string, progress?: TransferProgress): Promise<void>;
  downloadFile(remotePath: string, localPath: string, progress?: TransferProgress): Promise<void>;
  createFile(path: string): Promise<void>;
  stat(path: string): Promise<SftpFileStat>;
  dispose(): void;
}

export interface SftpManagerOptions {
  createSession(context: TerminalContext): SftpSessionLike;
  reporter?: TransferReporter;
}

interface ConnectionInvalidation {
  promise: Promise<never>;
  reject(error: Error): void;
}

interface ManagedSftpConnection {
  context: TerminalContext;
  session: SftpSessionLike | undefined;
  connectingSession: SftpSessionLike | undefined;
  connectingSessionPromise: Promise<SftpSessionLike> | undefined;
  connectingSessionInvalidation: ConnectionInvalidation | undefined;
  generation: number;
  rootPath: string | undefined;
  snapshot: { rootPath: string; entries: SftpEntry[] } | undefined;
}

export class SftpManager {
  private activeTerminalId: string | undefined;
  private readonly connections = new Map<string, ManagedSftpConnection>();
  private readonly transfers: TransferService;

  constructor(private readonly options: SftpManagerOptions) {
    this.transfers = new TransferService(options.reporter);
  }

  setTerminalContext(context: TerminalContext | undefined): void {
    if (!context) {
      this.activeTerminalId = undefined;
      return;
    }
    this.syncTerminalContext(context);
    this.activeTerminalId = context.terminalId;
  }

  syncTerminalContext(context: TerminalContext): void {
    const existing = this.connections.get(context.terminalId);
    if (!existing) {
      this.connections.set(context.terminalId, this.createManagedConnection(context));
      return;
    }

    const serverChanged = existing.context.server.id !== context.server.id;
    const reconnected = !existing.context.connected && context.connected;
    const disconnected = existing.context.connected && !context.connected;

    if (serverChanged || disconnected) {
      this.disposeManagedConnection(existing);
    }

    existing.context = context;
    if (serverChanged || reconnected) {
      existing.rootPath = undefined;
      existing.snapshot = undefined;
    }
    if (!context.connected) {
      this.disposeManagedConnection(existing);
    }
  }

  removeTerminalContext(terminalId: string): void {
    const connection = this.connections.get(terminalId);
    if (connection) {
      this.disposeManagedConnection(connection);
      this.connections.delete(terminalId);
    }
    if (this.activeTerminalId === terminalId) {
      this.activeTerminalId = undefined;
    }
  }

  dispose(): void {
    for (const connection of this.connections.values()) {
      this.disposeManagedConnection(connection);
    }
    this.connections.clear();
    this.activeTerminalId = undefined;
  }

  getState(): SftpTreeState {
    const connection = this.getActiveConnection();
    if (!connection) {
      return { kind: 'none' };
    }
    if (!connection.context.connected) {
      return connection.snapshot
        ? { kind: 'disconnected', rootPath: connection.snapshot.rootPath, entries: connection.snapshot.entries }
        : { kind: 'none' };
    }
    return { kind: 'active', rootPath: connection.rootPath ?? '.' };
  }

  getActiveServerId(): string | undefined {
    const connection = this.getActiveConnection();
    return connection?.context.connected ? connection.context.server.id : undefined;
  }

  async ensureRoot(): Promise<string> {
    const connection = this.requireConnection();
    const session = await this.ensureSession(connection);
    connection.rootPath = await session.realpath('.');
    return connection.rootPath;
  }

  async listDirectory(path?: string): Promise<SftpEntry[]> {
    const connection = this.requireConnection();
    const root = connection.rootPath ?? (await this.ensureRoot());
    const targetPath = path ?? root;
    const entries = await (await this.ensureSession(connection)).listDirectory(targetPath);
    if (targetPath === root) {
      this.setSnapshot(root, entries);
    }
    return entries;
  }

  async changeDirectory(path: string): Promise<string> {
    const connection = this.requireConnection();
    const session = await this.ensureSession(connection);
    connection.rootPath = await session.realpath(path);
    return connection.rootPath;
  }

  async changeToParentDirectory(): Promise<string> {
    const connection = this.requireConnection();
    const currentRoot = connection.rootPath ?? (await this.ensureRoot());
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

  async uploadFile(localPath: string, remotePath: string, serverId?: string): Promise<void> {
    await this.runConnected(
      `Upload ${remotePath}`,
      async (session, progress) => session.uploadFile(localPath, remotePath, progress),
      serverId
    );
  }

  async downloadFile(remotePath: string, localPath: string, serverId?: string): Promise<void> {
    await this.runConnected(
      `Download ${remotePath}`,
      async (session, progress) => session.downloadFile(remotePath, localPath, progress),
      serverId
    );
  }

  async readFile(remotePath: string, maxBytes: number, serverId?: string): Promise<Buffer> {
    const connection = this.requireConnection(serverId);
    return await (await this.ensureSession(connection)).readFile(remotePath, maxBytes);
  }

  async createFile(path: string): Promise<void> {
    await this.runConnected(`New file ${path}`, async (session) => session.createFile(path));
  }

  async stat(path: string, serverId?: string): Promise<SftpFileStat> {
    const connection = this.requireConnection(serverId);
    return await (await this.ensureSession(connection)).stat(path);
  }

  setSnapshot(rootPath: string, entries: SftpEntry[]): void {
    const connection = this.getActiveConnection();
    if (connection) {
      connection.snapshot = { rootPath, entries };
    }
  }

  private async ensureSession(connection: ManagedSftpConnection): Promise<SftpSessionLike> {
    const context = connection.context;
    if (!context.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    if (connection.session) {
      return connection.session;
    }
    if (connection.connectingSessionPromise) {
      return await connection.connectingSessionPromise;
    }

    const generation = connection.generation;
    const terminalId = context.terminalId;
    const session = this.options.createSession(context);
    connection.connectingSession = session;
    const invalidation = this.createConnectionInvalidation();
    connection.connectingSessionInvalidation = invalidation;
    const connect = Promise.race([Promise.resolve().then(() => session.connect()), invalidation.promise]);
    const promise = connect
      .then(() => {
        if (
          generation !== connection.generation ||
          connection.context.terminalId !== terminalId ||
          !connection.context.connected
        ) {
          throw new Error('SFTP connection was superseded by another active terminal.');
        }
        connection.session = session;
        return session;
      })
      .catch((error) => {
        session.dispose();
        if (connection.session === session) {
          connection.session = undefined;
        }
        throw error;
      })
      .finally(() => {
        if (connection.connectingSession === session) {
          connection.connectingSession = undefined;
        }
        if (connection.connectingSessionPromise === promise) {
          connection.connectingSessionPromise = undefined;
        }
        if (connection.connectingSessionInvalidation === invalidation) {
          connection.connectingSessionInvalidation = undefined;
        }
      });
    connection.connectingSessionPromise = promise;
    return await promise;
  }

  private createConnectionInvalidation(): ConnectionInvalidation {
    let reject!: (error: Error) => void;
    const promise = new Promise<never>((_, promiseReject) => {
      reject = promiseReject;
    });
    return { promise, reject };
  }

  private invalidateConnectingSession(connection: ManagedSftpConnection): void {
    const invalidation = connection.connectingSessionInvalidation;
    if (!invalidation) {
      return;
    }
    connection.connectingSessionInvalidation = undefined;
    invalidation.reject(new Error('SFTP connection was superseded by another active terminal.'));
  }

  private async runConnected<T>(
    label: string,
    job: (session: SftpSessionLike, progress: TransferProgress) => Promise<T>,
    serverId?: string
  ): Promise<T> {
    const connection = this.resolveConnection(serverId);
    await this.transfers.requireConnected(Boolean(connection?.context.connected));
    return await this.transfers.run(label, async (progress) => {
      return await job(await this.ensureSession(connection!), progress);
    });
  }

  private createManagedConnection(context: TerminalContext): ManagedSftpConnection {
    return {
      context,
      session: undefined,
      connectingSession: undefined,
      connectingSessionPromise: undefined,
      connectingSessionInvalidation: undefined,
      generation: 0,
      rootPath: undefined,
      snapshot: undefined
    };
  }

  private disposeManagedConnection(connection: ManagedSftpConnection): void {
    connection.generation++;
    this.invalidateConnectingSession(connection);
    connection.connectingSession?.dispose();
    connection.session?.dispose();
    connection.connectingSession = undefined;
    connection.connectingSessionPromise = undefined;
    connection.session = undefined;
  }

  private getActiveConnection(): ManagedSftpConnection | undefined {
    return this.activeTerminalId ? this.connections.get(this.activeTerminalId) : undefined;
  }

  private requireConnection(serverId?: string): ManagedSftpConnection {
    const connection = this.resolveConnection(serverId);
    if (!connection?.context.connected) {
      throw new Error('No connected SSH terminal is active.');
    }
    return connection;
  }

  private resolveConnection(serverId?: string): ManagedSftpConnection | undefined {
    if (!serverId) {
      return this.getActiveConnection();
    }
    const activeConnection = this.getActiveConnection();
    if (activeConnection?.context.connected && activeConnection.context.server.id === serverId) {
      return activeConnection;
    }
    return Array.from(this.connections.values())
      .reverse()
      .find((connection) => connection.context.connected && connection.context.server.id === serverId);
  }
}
