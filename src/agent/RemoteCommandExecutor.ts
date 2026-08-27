import type { Client, ClientChannel } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { quotePosixShellPath } from '../sftp/RemotePath';
import { getSsh2 } from '../ssh/ssh2Loader';
import {
  buildSshConnectionHandle,
  type HostKeyVerifier,
  type SshConnectionHandle
} from '../ssh/SshConnectionConfig';

export interface RemoteCommandRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RemoteCommandResult {
  serverId: string;
  serverLabel: string;
  host: string;
  command: string;
  cwd?: string;
  exitCode: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_OUTPUT_BYTES = 256_000;

/**
 * How long a pooled connection may sit unused before it is closed. Long enough to cover
 * the pauses in a conversation with an agent, short enough that an abandoned chat does
 * not hold a server-side session all day.
 */
const IDLE_CONNECTION_TTL_MS = 5 * 60_000;

class PooledConnection {
  /** Resolves once the connection is authenticated; rejects if it never got there. */
  readonly ready: Promise<Client>;
  client: Client | undefined;
  handle: SshConnectionHandle | undefined;
  /** Commands currently holding a channel on this connection. */
  inFlight = 0;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(open: (connection: PooledConnection) => Promise<Client>) {
    this.ready = open(this);
  }
}

interface ConnectionLease {
  client: Client;
  release(): void;
}

/**
 * Runs agent commands over SSH, reusing one connection per server.
 *
 * A fresh TCP + KEX + auth round trip per command costs a few hundred milliseconds each
 * (more with a jump host, which needs a second connection), which an agent firing a
 * dozen commands pays over and over. Connections are therefore keyed by `serverId` and
 * kept until they go idle, drop, or the extension shuts down.
 *
 * Concurrent commands on one server share the connection and open a channel each, which
 * is what SSH multiplexing is for; queueing them behind a single channel would serialize
 * an agent that legitimately fans out. A server whose `MaxSessions` is exhausted fails
 * that one `exec` rather than the whole connection.
 *
 * Reusing the `Client` behind an open terminal session would save one more connection,
 * but it would put the agent's commands at the mercy of the user closing that panel, so
 * the agent keeps its own.
 */
export class RemoteCommandExecutor {
  private readonly pool = new Map<string, PooledConnection>();
  private disposed = false;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier: HostKeyVerifier
  ) {}

  async execute(server: ServerConfig, request: RemoteCommandRequest): Promise<RemoteCommandResult> {
    const command = request.command.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }

    const timeoutMs = clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clampPositiveInteger(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();
    const execCommand = wrapCommand(command, request.cwd);
    let stream: ClientChannel | undefined;
    let settled = false;
    let timedOut = false;

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      const stdout = new OutputBuffer(maxOutputBytes);
      const stderr = new OutputBuffer(maxOutputBytes);
      let lease: ConnectionLease | undefined;
      // Armed before acquisition so the caller's timeout still covers a connection that
      // never comes up, not just a command that never returns.
      const timeout = setTimeout(() => {
        timedOut = true;
        stream?.close();
        finish(null);
      }, timeoutMs);

      const onConnectionLost = (error?: Error): void => {
        rejectOnce(error ?? new Error('SSH connection closed before the command finished.'));
      };
      const detach = (): void => {
        clearTimeout(timeout);
        if (!lease) {
          return;
        }
        lease.client.off('error', onConnectionLost);
        lease.client.off('close', onConnectionLost);
        lease.release();
      };

      function finish(exitCode: number | null, signal?: string): void {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        resolve({
          serverId: server.id,
          serverLabel: server.label,
          host: server.host,
          command,
          cwd: request.cwd,
          exitCode,
          signal,
          stdout: stdout.text(),
          stderr: timedOut ? `Command timed out after ${timeoutMs}ms.` : stderr.text(),
          durationMs: Date.now() - started,
          timedOut,
          truncated: stdout.truncated || stderr.truncated
        });
      }

      function rejectOnce(error: unknown): void {
        if (settled) {
          return;
        }
        settled = true;
        detach();
        reject(error);
      }

      void this.acquire(server).then((acquired) => {
        if (settled) {
          // Timed out while connecting; hand the connection straight back.
          acquired.release();
          return;
        }
        lease = acquired;
        acquired.client.once('error', onConnectionLost);
        acquired.client.once('close', onConnectionLost);
        acquired.client.exec(execCommand, (error, execStream) => {
          if (error) {
            rejectOnce(error);
            return;
          }

          stream = execStream;
          execStream.on('data', (data: Buffer) => stdout.append(data));
          execStream.stderr.on('data', (data: Buffer) => stderr.append(data));
          execStream.once('close', (code: number | null, signalName?: string) => {
            finish(code, signalName);
          });
        });
      }, rejectOnce);
    });
  }

  /** Closes every pooled connection. Must run on extension deactivate. */
  dispose(): void {
    this.disposed = true;
    for (const [serverId, connection] of [...this.pool]) {
      this.evict(serverId, connection);
    }
    this.pool.clear();
  }

  private async acquire(server: ServerConfig): Promise<ConnectionLease> {
    if (this.disposed) {
      throw new Error('The remote command executor has been disposed.');
    }

    let connection = this.pool.get(server.id);
    if (!connection || connection.closed) {
      connection = this.open(server);
      this.pool.set(server.id, connection);
    }

    connection.inFlight += 1;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }

    const held = connection;
    try {
      return {
        client: await held.ready,
        release: () => this.release(server.id, held)
      };
    } catch (error) {
      this.release(server.id, held);
      throw error;
    }
  }

  private open(server: ServerConfig): PooledConnection {
    const connection = new PooledConnection(async (self) => {
      // Pooling reuses an already-verified socket; every connection it opens still goes
      // through buildSshConnectionHandle, so host key verification is never skipped.
      const handle = await buildSshConnectionHandle(server, this.configManager, this.hostKeyVerifier);
      self.handle = handle;
      const client = new (await getSsh2()).Client();
      // Each in-flight command attaches its own error/close listeners, so the default
      // ceiling of 10 would warn once a handful of channels run at once.
      client.setMaxListeners(64);
      self.client = client;
      // A dropped connection must leave the pool, or the next command is handed a dead
      // client and fails for a reason that has nothing to do with the command.
      const drop = (): void => this.evict(server.id, self);
      client.on('error', drop);
      client.on('close', drop);
      client.on('end', drop);
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect(handle.config);
      });
      return client;
    });
    connection.ready.catch(() => this.evict(server.id, connection));

    return connection;
  }

  private release(serverId: string, connection: PooledConnection): void {
    connection.inFlight = Math.max(0, connection.inFlight - 1);
    if (connection.inFlight > 0 || connection.closed || connection.idleTimer) {
      return;
    }
    connection.idleTimer = setTimeout(() => this.evict(serverId, connection), IDLE_CONNECTION_TTL_MS);
    connection.idleTimer.unref?.();
  }

  private evict(serverId: string, connection: PooledConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    if (this.pool.get(serverId) === connection) {
      this.pool.delete(serverId);
    }
    connection.client?.end();
    connection.handle?.dispose();
  }
}

function wrapCommand(command: string, cwd: string | undefined): string {
  const trimmedCwd = cwd?.trim();
  if (!trimmedCwd) {
    return command;
  }
  return `cd ${quotePosixShellPath(trimmedCwd)} && ${command}`;
}

function clampPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, max);
}

class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly maxBytes: number) {}

  append(data: Buffer): void {
    if (this.size >= this.maxBytes) {
      this.truncated = true;
      return;
    }

    const remaining = this.maxBytes - this.size;
    if (data.length > remaining) {
      this.chunks.push(data.subarray(0, remaining));
      this.size = this.maxBytes;
      this.truncated = true;
      return;
    }

    this.chunks.push(data);
    this.size += data.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}
