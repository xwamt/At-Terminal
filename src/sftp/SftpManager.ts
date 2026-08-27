import type { TerminalContext } from '../terminal/TerminalContext';
import type { SftpTreeState, SftpViewDescriptor } from '../tree/SftpTreeProvider';
import { dirname } from './RemotePath';
import type { SftpUploadOptions } from './SftpSession';
import type { SftpEntry, SftpFileStat } from './SftpTypes';
import {
  TransferService,
  type TransferProgress,
  type TransferReporter,
  type TransferRunOptions
} from './TransferService';
import { t } from '../i18n/t';

/**
 * Directory listings served from this cache may be up to this stale. Mutating operations
 * invalidate the affected paths, so 20s only bounds how long changes made outside this
 * extension (another SSH session, cron) can stay invisible.
 */
export const LISTING_CACHE_TTL_MS = 20_000;

const LISTING_CACHE_KEY_SEPARATOR = '\u0000';
const QUIET: TransferRunOptions = { notification: 'quiet' };

function listingCacheKey(terminalId: string, path: string): string {
  return `${terminalId}${LISTING_CACHE_KEY_SEPARATOR}${path}`;
}

export interface SftpSessionLike {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  readFile(path: string, maxBytes: number, offset?: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  deleteDirectory(path: string): Promise<void>;
  countDeletableEntries(path: string): Promise<number>;
  uploadFile(
    localPath: string,
    remotePath: string,
    progress?: TransferProgress,
    options?: SftpUploadOptions
  ): Promise<void>;
  downloadFile(remotePath: string, localPath: string, progress?: TransferProgress): Promise<void>;
  uploadDirectory(
    localDir: string,
    remoteDir: string,
    progress?: TransferProgress,
    options?: SftpUploadOptions
  ): Promise<void>;
  downloadDirectory(remoteDir: string, localDir: string, progress?: TransferProgress): Promise<void>;
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
  /** Keyed by `terminalId\u0000path`; see {@link LISTING_CACHE_TTL_MS}. */
  private readonly listingCache = new Map<string, { entries: SftpEntry[]; expiresAt: number }>();

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
      this.clearListingsForTerminal(context.terminalId);
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
    this.listingCache.clear();
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

  /**
   * Snapshot of what the SFTP tree currently renders. `extension.ts` compares the descriptor
   * before and after an active-context change with `shouldRefreshOnContextChange` to skip
   * redundant full-tree refreshes when the user switches back to the same terminal.
   */
  getActiveViewDescriptor(): SftpViewDescriptor | undefined {
    const connection = this.getActiveConnection();
    if (!connection) {
      return undefined;
    }
    return {
      terminalId: connection.context.terminalId,
      rootPath: connection.rootPath,
      connected: connection.context.connected
    };
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
    const cacheKey = listingCacheKey(connection.context.terminalId, targetPath);
    const cached = this.listingCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (targetPath === root) {
        this.setSnapshot(root, cached.entries);
      }
      return cached.entries;
    }
    this.listingCache.delete(cacheKey);
    const entries = await (await this.ensureSession(connection)).listDirectory(targetPath);
    this.listingCache.set(cacheKey, { entries, expiresAt: Date.now() + LISTING_CACHE_TTL_MS });
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
    try {
      await this.runConnected('new folder', async (session) => session.mkdir(path), undefined, QUIET);
    } finally {
      this.invalidateListings(path);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.runConnected('rename', async (session) => session.rename(oldPath, newPath), undefined, QUIET);
    } finally {
      this.invalidateListings(oldPath);
      this.invalidateListings(newPath);
    }
  }

  async deleteEntry(entry: SftpEntry): Promise<void> {
    try {
      await this.runConnected(
        'delete',
        async (session) => {
          if (entry.type === 'directory') {
            await session.deleteDirectory(entry.path);
            return;
          }
          await session.deleteFile(entry.path);
        },
        undefined,
        QUIET
      );
    } finally {
      this.invalidateListings(entry.path);
    }
  }

  /**
   * Dry run for a recursive directory delete: how many entries would be removed (the
   * directory itself included), so the UI can confirm with a concrete number.
   */
  async countDeletableEntries(path: string, serverId?: string): Promise<number> {
    const connection = this.requireConnection(serverId);
    return await (await this.ensureSession(connection)).countDeletableEntries(path);
  }

  async uploadFile(
    localPath: string,
    remotePath: string,
    serverId?: string,
    options?: SftpUploadOptions
  ): Promise<void> {
    try {
      await this.runConnected(
        t('Upload {path}', { path: remotePath }),
        async (session, progress) => session.uploadFile(localPath, remotePath, progress, options),
        serverId
      );
    } finally {
      this.invalidateListings(remotePath);
    }
  }

  async downloadFile(remotePath: string, localPath: string, serverId?: string): Promise<void> {
    await this.runConnected(
      t('Download {path}', { path: remotePath }),
      async (session, progress) => session.downloadFile(remotePath, localPath, progress),
      serverId
    );
  }

  async uploadDirectory(
    localDir: string,
    remoteDir: string,
    serverId?: string,
    options?: SftpUploadOptions
  ): Promise<void> {
    try {
      await this.runConnected(
        t('Upload {path}', { path: remoteDir }),
        async (session, progress) => session.uploadDirectory(localDir, remoteDir, progress, options),
        serverId
      );
    } finally {
      this.invalidateListings(remoteDir);
    }
  }

  async downloadDirectory(remoteDir: string, localDir: string, serverId?: string): Promise<void> {
    await this.runConnected(
      t('Download {path}', { path: remoteDir }),
      async (session, progress) => session.downloadDirectory(remoteDir, localDir, progress),
      serverId
    );
  }

  async readFile(remotePath: string, maxBytes: number, serverId?: string, offset = 0): Promise<Buffer> {
    const connection = this.requireConnection(serverId);
    return await (await this.ensureSession(connection)).readFile(remotePath, maxBytes, offset);
  }

  async createFile(path: string): Promise<void> {
    try {
      await this.runConnected(t('New file {path}', { path }), async (session) => session.createFile(path), undefined, QUIET);
    } finally {
      this.invalidateListings(path);
    }
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
      throw new Error(t('No connected SSH terminal is active.'));
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
          throw new Error(t('SFTP connection was superseded by another active terminal.'));
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
    invalidation.reject(new Error(t('SFTP connection was superseded by another active terminal.')));
  }

  private async runConnected<T>(
    label: string,
    job: (session: SftpSessionLike, progress: TransferProgress) => Promise<T>,
    serverId?: string,
    options?: TransferRunOptions
  ): Promise<T> {
    const connection = this.resolveConnection(serverId);
    await this.transfers.requireConnected(Boolean(connection?.context.connected));
    return await this.transfers.run(
      label,
      async (progress) => {
        return await job(await this.ensureSession(connection!), progress);
      },
      options
    );
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
    this.clearListingsForTerminal(connection.context.terminalId);
  }

  /**
   * Drops cached listings for the mutated path, its parent (whose listing names it), and any
   * cached descendants. Keys are matched across every terminal because two terminals on the
   * same server see the same filesystem; over-invalidating an unrelated terminal only costs a
   * cache miss.
   */
  private invalidateListings(path: string): void {
    const parent = dirname(path);
    const prefix = path.endsWith('/') ? path : `${path}/`;
    for (const key of Array.from(this.listingCache.keys())) {
      const keyPath = key.slice(key.indexOf(LISTING_CACHE_KEY_SEPARATOR) + 1);
      if (keyPath === path || keyPath === parent || keyPath.startsWith(prefix)) {
        this.listingCache.delete(key);
      }
    }
  }

  private clearListingsForTerminal(terminalId: string): void {
    const prefix = `${terminalId}${LISTING_CACHE_KEY_SEPARATOR}`;
    for (const key of Array.from(this.listingCache.keys())) {
      if (key.startsWith(prefix)) {
        this.listingCache.delete(key);
      }
    }
  }

  private getActiveConnection(): ManagedSftpConnection | undefined {
    return this.activeTerminalId ? this.connections.get(this.activeTerminalId) : undefined;
  }

  private requireConnection(serverId?: string): ManagedSftpConnection {
    const connection = this.resolveConnection(serverId);
    if (!connection?.context.connected) {
      throw new Error(t('No connected SSH terminal is active.'));
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
