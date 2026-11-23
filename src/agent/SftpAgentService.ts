import { realpath as realpathLocal, stat as statLocal } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve as resolveLocal, sep as sepLocal } from 'node:path';
import type { ServerConfig } from '../config/schema';
import type { SftpEntry, SftpEntryType, SftpFileStat } from '../sftp/SftpTypes';
import { dirname, joinRemotePath } from '../sftp/RemotePath';
import type { TerminalContext, TerminalContextRegistry } from '../terminal/TerminalContext';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { SftpWriteAuthorizer } from './SftpWriteAuthorizer';

export interface AgentSftpSession {
  connect(): Promise<void>;
  /** Optional; when present a cached session is discarded rather than reused dead. */
  isConnected?(): boolean;
  realpath(path?: string): Promise<string>;
  listDirectory(path: string): Promise<SftpEntry[]>;
  stat(path: string): Promise<SftpFileStat>;
  readFile(path: string, maxBytes: number, offset?: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer): Promise<void>;
  /** Optional streamed upload, used by `localPath` so large files never enter model context. */
  uploadFile?(
    localPath: string,
    remotePath: string,
    progress?: unknown,
    options?: { overwrite?: boolean }
  ): Promise<void>;
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
  /**
   * Builds a background session. Production passes a session that rides the shared
   * {@link AgentSshClientPool}, so a command and an SFTP call in the same conversation
   * authenticate once. Falls back to `createSession` when omitted.
   */
  createBackgroundSession?(target: { server: ServerConfig }): AgentSftpSession;
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
export const WRITE_TIMEOUT_MS = 60_000;
/**
 * Read-side timeout. An SFTP channel that stalls (dropped network mid-transfer, server
 * frozen) must fail the tool call instead of parking the MCP request forever.
 */
export const READ_TIMEOUT_MS = 30_000;
/** In-place edits above this size are rejected: the whole file has to round-trip anyway. */
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;

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
        const entries = await withTimeout(
          lease.session.listDirectory(path),
          READ_TIMEOUT_MS,
          `Timed out listing remote directory ${path} after ${READ_TIMEOUT_MS}ms.`
        );
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
          ...(await withTimeout(
            lease.session.stat(path),
            READ_TIMEOUT_MS,
            `Timed out reading metadata for ${path} after ${READ_TIMEOUT_MS}ms.`
          ))
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
        const stat = await withTimeout(
          lease.session.stat(path),
          READ_TIMEOUT_MS,
          `Timed out reading metadata for ${path} after ${READ_TIMEOUT_MS}ms.`
        );
        const maxBytes = clampReadBytes(input.maxBytes);
        const start = resolveReadStart(input.offset, stat.size);
        const window = Math.min(Math.max(stat.size - start, 0), maxBytes);
        const buffer =
          window === 0
            ? Buffer.alloc(0)
            : (
                await withTimeout(
                  lease.session.readFile(path, window, start),
                  READ_TIMEOUT_MS,
                  `Timed out reading remote file ${path} after ${READ_TIMEOUT_MS}ms.`
                )
              ).subarray(0, window);
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

  async writeFile(input: SftpTargetInput & {
    path: string;
    content?: string;
    overwrite?: boolean;
    expectedSize?: number;
    expectedModifiedAt?: number;
    localPath?: string;
  }) {
    return await this.withAudit('sftp_write_file', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        const existing = await statOrUndefined(lease.session, path);
        const exists = existing !== undefined;
        if (exists && !input.overwrite) {
          throw new Error('Remote file already exists. Pass overwrite: true to replace it.');
        }
        assertExpectedVersion(existing, input);
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'write_file',
            path,
            overwrite: exists,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP write authorization for ${path}.`
        );
        let bytesWritten: number;
        if (input.localPath !== undefined) {
          if (input.content !== undefined) {
            throw new Error('Pass either content or localPath, not both.');
          }
          if (!lease.session.uploadFile) {
            throw new Error('This SFTP session does not support local file uploads.');
          }
          const local = await resolveLocalUploadFile(input.localPath);
          await withTimeout(
            lease.session.uploadFile(local.path, path, undefined, { overwrite: exists }),
            WRITE_TIMEOUT_MS,
            `Timed out uploading ${local.path} to ${path}.`
          );
          bytesWritten = local.size;
        } else {
          if (input.content === undefined) {
            throw new Error('Either content or localPath is required.');
          }
          const content = Buffer.from(input.content, 'utf8');
          await withTimeout(
            lease.session.writeFile(path, content),
            WRITE_TIMEOUT_MS,
            `Timed out writing remote file ${path}.`
          );
          bytesWritten = content.length;
        }
        const updated = await statOrUndefined(lease.session, path);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          bytesWritten,
          overwritten: exists,
          size: updated?.size,
          modifiedAt: updated?.modifiedAt
        };
      } finally {
        lease.release();
      }
    });
  }

  /**
   * Targeted literal replacement with optimistic locking. Saves the model from emitting a
   * whole file just to change one line, and refuses to overwrite a file that changed since
   * the caller last read it.
   */
  async editFile(input: SftpTargetInput & {
    path: string;
    oldText: string;
    newText: string;
    expectedSize?: number;
    expectedModifiedAt?: number;
    replaceAll?: boolean;
  }) {
    return await this.withAudit('sftp_edit_file', input, async () => {
      const target = await this.resolveTarget(input);
      const lease = await this.leaseFor(target);
      try {
        const { path, workspaceRoot } = await this.resolveWritablePath(lease, input.path);
        if (!input.oldText) {
          throw new Error('oldText cannot be empty.');
        }
        const stat = await statOrUndefined(lease.session, path);
        if (!stat) {
          throw new Error('Remote file was not found.');
        }
        assertExpectedVersion(stat, input);
        if (stat.size > MAX_EDIT_FILE_BYTES) {
          throw new Error(
            `Remote file is too large for in-place editing (${stat.size} bytes; limit ${MAX_EDIT_FILE_BYTES}). ` +
              'Use sftp_read_file in chunks and sftp_write_file, or download it.'
          );
        }
        const current = await withTimeout(
          lease.session.readFile(path, stat.size, 0),
          READ_TIMEOUT_MS,
          `Timed out reading remote file ${path} after ${READ_TIMEOUT_MS}ms.`
        );
        const text = current.subarray(0, stat.size).toString('utf8');
        const occurrences = countOccurrences(text, input.oldText);
        if (occurrences === 0) {
          throw new Error('oldText was not found in the remote file.');
        }
        if (occurrences > 1 && !input.replaceAll) {
          throw new Error(
            `oldText matched ${occurrences} times; pass replaceAll: true or include more surrounding text.`
          );
        }
        const updatedText = input.replaceAll
          ? text.split(input.oldText).join(input.newText)
          : text.replace(input.oldText, () => input.newText);
        await withTimeout(
          this.options.authorizer.requireWrite(target.server, {
            operation: 'edit_file',
            path,
            overwrite: true,
            workspaceRoot
          }),
          WRITE_TIMEOUT_MS,
          `Timed out waiting for SFTP edit authorization for ${path}.`
        );
        // Re-check immediately before the write: the file may have changed while the
        // authorization dialog was open.
        const latest = await statOrUndefined(lease.session, path);
        if (!latest) {
          throw new Error('Remote file was removed before the edit could be written.');
        }
        assertExpectedVersion(latest, input);
        if (latest.size !== stat.size || latest.modifiedAt !== stat.modifiedAt) {
          throw new Error('Remote file changed while the edit was being prepared; re-read it and retry.');
        }
        const content = Buffer.from(updatedText, 'utf8');
        await withTimeout(
          lease.session.writeFile(path, content),
          WRITE_TIMEOUT_MS,
          `Timed out writing remote file ${path}.`
        );
        const after = await statOrUndefined(lease.session, path);
        return {
          terminalId: target.terminalId,
          serverId: target.server.id,
          path,
          replacements: input.replaceAll ? occurrences : 1,
          bytesWritten: content.length,
          size: after?.size,
          modifiedAt: after?.modifiedAt
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
      const session = await existing.promise;
      if (session.isConnected?.() === false) {
        this.disposeTerminal(context.terminalId);
      } else {
        return session;
      }
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
    if (entry && !entry.closed && entry.session.isConnected?.() === false) {
      this.evictBackgroundSession(server.id, entry);
      entry = undefined;
    }
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
    const createSession = this.options.createBackgroundSession ?? this.options.createSession;
    const session = createSession({ server });
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
    if (!path || path === '.' || path === '~/') {
      return root;
    }
    const expanded = expandHome(path, root);
    return expanded.startsWith('/')
      ? await withTimeout(
          lease.session.realpath(expanded),
          READ_TIMEOUT_MS,
          `Timed out resolving remote path ${expanded} after ${READ_TIMEOUT_MS}ms.`
        )
      : await withTimeout(
          lease.session.realpath(`${root}/${expanded}`),
          READ_TIMEOUT_MS,
          `Timed out resolving remote path ${expanded} after ${READ_TIMEOUT_MS}ms.`
        );
  }

  private async resolveWritablePath(lease: SessionLease, path: string): Promise<WritableTarget> {
    if (!path.trim()) {
      throw new Error('Remote path cannot be empty.');
    }
    const workspaceRoot = await this.rootFor(lease);
    const expanded = expandHome(path.trim(), workspaceRoot);
    const candidate = expanded.startsWith('/') ? expanded : joinRemotePath(workspaceRoot, expanded);
    const normalized = candidate.replace(/\/+$/, '') || '/';
    if (normalized === '/') {
      throw new Error('Remote root path cannot be modified.');
    }
    const parent = await withTimeout(
      lease.session.realpath(dirname(normalized)),
      READ_TIMEOUT_MS,
      `Timed out resolving remote path ${normalized} after ${READ_TIMEOUT_MS}ms.`
    );
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
    const root = await withTimeout(
      lease.session.realpath('.'),
      READ_TIMEOUT_MS,
      `Timed out resolving the remote home directory after ${READ_TIMEOUT_MS}ms.`
    );
    this.roots.set(lease.rootKey, root);
    return root;
  }
}

/** SFTP has no notion of `~`; the session root (`realpath('.')`) is the login home. */
function expandHome(path: string, workspaceRoot: string): string {
  if (path === '~') {
    return workspaceRoot;
  }
  if (path.startsWith('~/')) {
    return joinRemotePath(workspaceRoot, path.slice(2));
  }
  return path;
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

async function statOrUndefined(session: AgentSftpSession, path: string): Promise<SftpFileStat | undefined> {
  try {
    return await session.stat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertExpectedVersion(
  stat: SftpFileStat | undefined,
  expected: { expectedSize?: number; expectedModifiedAt?: number }
): void {
  if (expected.expectedSize !== undefined && stat?.size !== expected.expectedSize) {
    throw new Error(
      `Remote file changed: expected size ${expected.expectedSize}, found ${stat ? stat.size : 'a missing file'}. Re-read it and retry.`
    );
  }
  if (expected.expectedModifiedAt !== undefined && stat?.modifiedAt !== expected.expectedModifiedAt) {
    throw new Error(
      `Remote file changed: expected modifiedAt ${expected.expectedModifiedAt}, found ${stat ? stat.modifiedAt : 'a missing file'}. Re-read it and retry.`
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Resolves a host-side upload path and refuses credential stores. `localPath` exists to
 * stream large files that should never pass through the model context; without this guard
 * a prompt-injected model could exfiltrate the user's private keys to a remote server.
 */
async function resolveLocalUploadFile(localPath: string): Promise<{ path: string; size: number }> {
  const resolved = await realpathLocal(localPath);
  const home = homedir();
  const sensitiveRoots = [
    resolveLocal(home, '.ssh'),
    resolveLocal(home, '.gnupg'),
    resolveLocal(home, '.aws'),
    resolveLocal(home, '.kube'),
    resolveLocal(home, '.docker'),
    resolveLocal(home, '.config', 'gcloud'),
    resolveLocal(home, '.config', 'gh'),
    resolveLocal(home, '.netrc'),
    resolveLocal(home, '.pgpass'),
    resolveLocal(home, '.bash_history')
  ];
  for (const root of sensitiveRoots) {
    if (resolved === root || resolved.startsWith(`${root}${sepLocal}`)) {
      throw new Error(`Refusing to read sensitive local path ${resolved}.`);
    }
  }
  const stats = await statLocal(resolved);
  if (!stats.isFile()) {
    throw new Error(`Local path ${resolved} is not a regular file.`);
  }
  return { path: resolved, size: stats.size };
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
