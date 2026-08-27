import type { ServerConfig } from '../config/schema';
import type { SftpEntry, SftpEntryType, SftpFileStat } from '../sftp/SftpTypes';
import { dirname, joinRemotePath } from '../sftp/RemotePath';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

export interface AgentSftpSession {
  connect(): Promise<void>;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpFileStat>;
  readFile(path: string, maxBytes: number, offset?: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  createFile(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  dispose(): void;
}

export interface SftpAgentServiceOptions {
  terminalContext: TerminalContextRegistry;
  /**
   * Builds a session for the given server. Terminal-bound and background targets share
   * this factory; production must construct it with `allowSudoFallback: false` so a
   * denied agent write stays denied.
   */
  createSession(target: { server: ServerConfig }): AgentSftpSession;
  authorizer: Pick<SftpWriteAuthorizer, 'requireWrite' | 'requireDelete'>;
  /**
   * Looks a server up by id for background SFTP (no connected UI terminal). Servers
   * resolved this way must have `backgroundConnectionAllowed === true` or the call is
   * refused before any connection is made.
   */
  resolveBackgroundServer?(serverId: string): Promise<ServerConfig | undefined>;
  audit?: AgentAuditRecorder;
}

export interface SftpTargetInput {
  terminalId?: string;
  serverId?: string;
}

interface SftpTarget {
  /** Present only when the target is a connected UI terminal. */
  terminalId?: string;
  server: ServerConfig;
  context?: TerminalContext;
}

interface SessionLease {
  session: AgentSftpSession;
  /** Key for the cached `realpath('.')`; terminal and background sessions never collide. */
  rootKey: string;
  release(): void;
}

interface TerminalSessionEntry {
  serverId: string;
  promise: Promise<AgentSftpSession>;
}

interface BackgroundSessionEntry {
  session: AgentSftpSession;
  ready: Promise<AgentSftpSession>;
  /** Operations currently using this session. */
  inFlight: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
}

interface WritableTarget {
  /** Server-resolved absolute path of the write target. */
  path: string;
  /** `realpath('.')` for this session, used as the write jail. */
  workspaceRoot: string;
}

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 500;
const MAX_ENTRIES = 5_000;
const WRITE_TIMEOUT_MS = 60_000;

/**
 * How long an idle background session is kept before its SSH connection is closed.
 * Mirrors `RemoteCommandExecutor`: long enough for the pauses in an agent conversation,
 * short enough that an abandoned chat does not hold a server-side session all day.
 */
const BACKGROUND_IDLE_TTL_MS = 5 * 60_000;

export class SftpAgentService {
  /** One session per connected UI terminal; lives until the terminal closes. */
  private readonly terminalSessions = new Map<string, TerminalSessionEntry>();
  /** One session per background server, reaped after BACKGROUND_IDLE_TTL_MS idle. */
  private readonly backgroundSessions = new Map<string, BackgroundSessionEntry>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly options: SftpAgentServiceOptions) {}

  async listDirectory(input: SftpTargetInput & { path?: string; maxEntries?: number; offset?: number }) {
    return await this.withAudit('sftp_list_directory', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        const entries = await lease.session.listDirectory(path);
        const maxEntries = clampMaxEntries(input.maxEntries);
        const offset = clampListOffset(input.offset);
        const page = entries.slice(offset, offset + maxEntries);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          entries: page,
          truncated: offset + page.length < entries.length,
          offset,
          total: entries.length
        };
      } finally {
        lease.release();
      }
    });
  }

  async statPath(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_stat_path', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          ...(await lease.session.stat(path))
        };
      } finally {
        lease.release();
      }
    });
  }

  async readFile(input: SftpTargetInput & { path: string; maxBytes?: number; offset?: number }) {
    return await this.withAudit('sftp_read_file', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const path = await this.resolvePath(lease, input.path);
        const stat = await lease.session.stat(path);
        const maxBytes = clampReadBytes(input.maxBytes);
        const start = resolveReadStart(input.offset, stat.size);
        const window = Math.min(Math.max(stat.size - start, 0), maxBytes);
        const buffer =
          window === 0
            ? Buffer.alloc(0)
            : (await lease.session.readFile(path, window, start)).subarray(0, window);
        if (looksBinary(buffer)) {
          throw new Error('Remote file appears to be binary.');
        }
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          content: buffer.toString('utf8'),
          truncated: start + buffer.length < stat.size,
          offset: start,
          size: stat.size,
          modifiedAt: stat.modifiedAt
        };
      } finally {
        lease.release();
      }
    });
  }

  async writeFile(input: SftpTargetInput & { path: string; content: string; overwrite?: boolean }) {
    return await this.withAudit('sftp_write_file', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        const exists = await pathExists(lease.session, path);
        if (exists && !input.overwrite) {
          throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
        }
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'write_file',
            path,
            overwrite: Boolean(exists),
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP write authorization for ${path}.`
        );
        const content = Buffer.from(input.content, 'utf8');
        await withTimeout(
          lease.session.writeFile(path, content),
          WRITE_TIMEOUT_MS,
          `Timed out writing remote file ${path}.`
        );
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          bytesWritten: content.length,
          overwritten: exists
        };
      } finally {
        lease.release();
      }
    });
  }

  async createFile(input: SftpTargetInput & { path: string; content?: string }) {
    return await this.withAudit('sftp_create_file', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        if (await pathExists(lease.session, path)) {
          throw new Error('Remote file already exists.');
        }
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'create_file',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP create authorization for ${path}.`
        );
        if (input.content === undefined) {
          await withTimeout(
            lease.session.createFile(path),
            WRITE_TIMEOUT_MS,
            `Timed out creating remote file ${path}.`
          );
        } else {
          await withTimeout(
            lease.session.writeFile(path, Buffer.from(input.content, 'utf8')),
            WRITE_TIMEOUT_MS,
            `Timed out writing remote file ${path}.`
          );
        }
        return { terminalId: target.terminalId, serverId: target.server.id, path };
      } finally {
        lease.release();
      }
    });
  }

  async createDirectory(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_create_directory', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'create_directory',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP create directory authorization for ${path}.`
        );
        await withTimeout(
          lease.session.mkdir(path),
          WRITE_TIMEOUT_MS,
          `Timed out creating remote directory ${path}.`
        );
        return { terminalId: target.terminalId, serverId: target.server.id, path };
      } finally {
        lease.release();
      }
    });
  }

  async rename(input: SftpTargetInput & { path: string; newPath: string }) {
    return await this.withAudit('sftp_rename', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const source = await this.resolveWritablePath(lease, input.path);
        const destination = await this.resolveWritablePath(lease, input.newPath);
        if (!(await pathExists(lease.session, source.path))) {
          throw new Error('Remote source path was not found.');
        }
        if (await pathExists(lease.session, destination.path)) {
          throw new Error('Remote destination already exists.');
        }
        // Both ends go through write authorization: moving a file out of an approved
        // directory is as much a write as creating one there.
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'rename',
            path: source.path,
            overwrite: false,
            workspaceRoot: source.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP rename authorization for ${source.path}.`
        );
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'rename',
            path: destination.path,
            overwrite: false,
            workspaceRoot: destination.workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP rename authorization for ${destination.path}.`
        );
        await withTimeout(
          lease.session.rename(source.path, destination.path),
          WRITE_TIMEOUT_MS,
          `Timed out renaming remote path ${source.path}.`
        );
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path: source.path,
          newPath: destination.path
        };
      } finally {
        lease.release();
      }
    });
  }

  async deleteFile(input: SftpTargetInput & { path: string }) {
    return await this.withAudit('sftp_delete', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        const entryType = await remoteEntryType(lease.session, path);
        if (entryType === undefined) {
          throw new Error('Remote file was not found.');
        }
        if (entryType === 'directory') {
          throw new Error('sftp_delete removes single files only; directories are refused.');
        }
        await withTimeout(
          this.options.authorizer.requireDelete(target.server, {
            operation: 'delete_file',
            path,
            overwrite: false,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP delete confirmation for ${path}.`
        );
        await withTimeout(
          lease.session.deleteFile(path),
          WRITE_TIMEOUT_MS,
          `Timed out deleting remote file ${path}.`
        );
        return { terminalId: target.terminalId, serverId: target.server.id, path, deleted: true };
      } finally {
        lease.release();
      }
    });
  }

  /** Drops the pooled session bound to a closed terminal. Wire to `onDidRemoveContext`. */
  disposeTerminal(terminalId: string): void {
    const entry = this.terminalSessions.get(terminalId);
    if (entry) {
      this.terminalSessions.delete(terminalId);
      void entry.promise.then(
        (session) => session.dispose(),
        () => undefined
      );
    }
    this.roots.delete(`terminal:${terminalId}`);
  }

  /** Drops every pooled session for a server, e.g. after the server is deleted or edited. */
  disposeServer(serverId: string): void {
    const background = this.backgroundSessions.get(serverId);
    if (background) {
      this.evictBackgroundSession(serverId, background);
    }
    for (const [terminalId, entry] of [...this.terminalSessions]) {
      if (entry.serverId === serverId) {
        this.disposeTerminal(terminalId);
      }
    }
    this.roots.delete(`server:${serverId}`);
  }

  dispose(): void {
    for (const [serverId, entry] of [...this.backgroundSessions]) {
      this.evictBackgroundSession(serverId, entry);
    }
    this.backgroundSessions.clear();
    for (const entry of this.terminalSessions.values()) {
      void entry.promise.then(
        (session) => session.dispose(),
        () => undefined
      );
    }
    this.terminalSessions.clear();
    this.roots.clear();
  }

  private async resolveTarget(input: SftpTargetInput): Promise<SftpTarget> {
    const context =
      this.options.terminalContext.getConnectedTerminalById(input.terminalId) ??
      this.options.terminalContext.getConnectedTerminalByServerId(input.serverId) ??
      (!input.terminalId && !input.serverId ? this.options.terminalContext.getConnectedTerminal() : undefined);
    if (context) {
      return { terminalId: context.terminalId, server: context.server, context };
    }
    if (input.serverId && this.options.resolveBackgroundServer) {
      const server = await this.options.resolveBackgroundServer(input.serverId);
      if (!server) {
        throw new Error(`SSH server "${input.serverId}" was not found.`);
      }
      if (server.backgroundConnectionAllowed !== true) {
        throw new Error(
          `SSH server "${server.id}" does not allow background connections. ` +
            'Ask the user to enable "Allow background connections" on the AT Terminal server edit form, ' +
            'or connect an AT Terminal session to that server.'
        );
      }
      return { server };
    }
    throw new Error(
      'No matching connected AT Terminal SSH session is available. Connect an AT Terminal session first.'
    );
  }

  private async leaseFor(target: SftpTarget): Promise<SessionLease> {
    if (target.context) {
      const session = await this.ensureTerminalSession(target.context);
      return {
        session,
        rootKey: `terminal:${target.context.terminalId}`,
        release: () => undefined
      };
    }
    return await this.leaseBackgroundSession(target.server);
  }

  private async ensureTerminalSession(context: TerminalContext): Promise<AgentSftpSession> {
    const existing = this.terminalSessions.get(context.terminalId);
    if (existing) {
      return await existing.promise;
    }
    const session = this.options.createSession({ server: context.server });
    const promise = Promise.resolve()
      .then(async () => {
        await session.connect();
        return session;
      })
      .catch((error) => {
        session.dispose();
        this.terminalSessions.delete(context.terminalId);
        throw error;
      });
    this.terminalSessions.set(context.terminalId, { serverId: context.server.id, promise });
    return await promise;
  }

  private async leaseBackgroundSession(server: ServerConfig): Promise<SessionLease> {
    let entry = this.backgroundSessions.get(server.id);
    if (!entry || entry.closed) {
      entry = this.openBackgroundSession(server);
      this.backgroundSessions.set(server.id, entry);
    }
    entry.inFlight += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const held = entry;
    try {
      const session = await held.ready;
      return {
        session,
        rootKey: `server:${server.id}`,
        release: () => this.releaseBackgroundSession(server.id, held)
      };
    } catch (error) {
      this.releaseBackgroundSession(server.id, held);
      throw error;
    }
  }

  private openBackgroundSession(server: ServerConfig): BackgroundSessionEntry {
    const session = this.options.createSession({ server });
    const entry: BackgroundSessionEntry = {
      session,
      inFlight: 0,
      idleTimer: undefined,
      closed: false,
      ready: Promise.resolve().then(async () => {
        await session.connect();
        return session;
      })
    };
    // A session that never connected must leave the pool, or the next call is handed a
    // dead session and fails for a reason unrelated to the call itself.
    entry.ready.catch(() => this.evictBackgroundSession(server.id, entry));
    return entry;
  }

  private releaseBackgroundSession(serverId: string, entry: BackgroundSessionEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight > 0 || entry.closed || entry.idleTimer) {
      return;
    }
    entry.idleTimer = setTimeout(() => this.evictBackgroundSession(serverId, entry), BACKGROUND_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  private evictBackgroundSession(serverId: string, entry: BackgroundSessionEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (this.backgroundSessions.get(serverId) === entry) {
      this.backgroundSessions.delete(serverId);
      this.roots.delete(`server:${serverId}`);
    }
    entry.session.dispose();
  }

  private async withAudit<
    T extends { serverId?: string; terminalId?: string; path?: string; truncated?: boolean }
  >(tool: string, input: SftpTargetInput & { path?: string }, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      this.options.audit?.record({
        tool,
        serverId: result.serverId ?? input.serverId,
        terminalId: result.terminalId ?? input.terminalId,
        path: result.path ?? input.path,
        reasonCode: 'ok',
        durationMs: Date.now() - started,
        ...(result.truncated === undefined ? {} : { truncated: result.truncated })
      });
      return result;
    } catch (error) {
      this.options.audit?.record({
        tool,
        serverId: input.serverId,
        terminalId: input.terminalId,
        path: input.path,
        reasonCode: auditReasonForError(error),
        durationMs: Date.now() - started
      });
      throw error;
    }
  }

  private async resolvePath(lease: SessionLease, path: string | undefined): Promise<string> {
    const root = await this.rootFor(lease);
    if (!path || path === '.') {
      return root;
    }
    return path.startsWith('/') ? await lease.session.realpath(path) : await lease.session.realpath(`${root}/${path}`);
  }

  private async resolveWritablePath(lease: SessionLease, path: string): Promise<WritableTarget> {
    if (!path.trim()) {
      throw new Error('Remote path cannot be empty.');
    }
    const workspaceRoot = await this.rootFor(lease);
    const candidate = path.startsWith('/') ? path : joinRemotePath(workspaceRoot, path);
    const normalized = candidate.replace(/\/+$/, '') || '/';
    if (normalized === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    const parent = await lease.session.realpath(dirname(normalized));
    const resolved = joinRemotePath(parent, basenameRemotePath(normalized));
    if (resolved === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    return { path: resolved, workspaceRoot };
  }

  private async rootFor(lease: SessionLease): Promise<string> {
    const existing = this.roots.get(lease.rootKey);
    if (existing) {
      return existing;
    }
    const root = await lease.session.realpath('.');
    this.roots.set(lease.rootKey, root);
    return root;
  }
}

async function pathExists(session: AgentSftpSession, path: string): Promise<boolean> {
  try {
    await session.stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

/** Type of the directory entry at `path`, read from its parent listing; undefined when absent. */
async function remoteEntryType(session: AgentSftpSession, path: string): Promise<SftpEntryType | undefined> {
  const entries = await session.listDirectory(dirname(path));
  const name = basenameRemotePath(path);
  return entries.find((entry) => entry.name === name)?.type;
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === 'ENOENT';
}

function basenameRemotePath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

function clampReadBytes(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_READ_BYTES;
  }
  return Math.min(value, MAX_READ_BYTES);
}

function clampMaxEntries(value: number | undefined): number {
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    return DEFAULT_MAX_ENTRIES;
  }
  return Math.min(value, MAX_ENTRIES);
}

function clampListOffset(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return 0;
  }
  return value;
}

/** Byte position a read starts at; negative offsets count back from the end of the file. */
function resolveReadStart(offset: number | undefined, size: number): number {
  if (offset === undefined || !Number.isInteger(offset) || offset === 0) {
    return 0;
  }
  if (offset < 0) {
    return Math.max(0, size + offset);
  }
  return Math.min(offset, size);
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function auditReasonForError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('was cancelled')) {
    return 'user_cancelled';
  }
  if (message.includes('does not allow background connections')) {
    return 'background_denied';
  }
  if (message.includes('Timed out waiting for SFTP')) {
    return 'confirmation_timeout';
  }
  return 'error';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
