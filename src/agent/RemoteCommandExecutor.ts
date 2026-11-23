import type { ClientChannel } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { quotePosixShellPath } from '../sftp/RemotePath';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { AgentSshClientPool, type AgentSshClientLease } from './AgentSshClientPool';

export interface RemoteCommandRequest {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Aborted when the MCP client disconnects or the user presses Stop. */
  signal?: AbortSignal;
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
 * Runs agent commands over SSH, reusing one connection per server.
 *
 * A fresh TCP + KEX + auth round trip per command costs a few hundred milliseconds each
 * (more with a jump host, which needs a second connection), which an agent firing a
 * dozen commands pays over and over. The underlying {@link AgentSshClientPool} is shared
 * with the background SFTP tools so a mixed conversation authenticates once, not twice.
 *
 * Concurrent commands on one server share the connection and open a channel each, which
 * is what SSH multiplexing is for; queueing them behind a single channel would serialize
 * an agent that legitimately fans out. A server whose `MaxSessions` is exhausted fails
 * that one `exec` rather than the whole connection.
 */
export class RemoteCommandExecutor {
  private readonly pool: AgentSshClientPool;
  private disposed = false;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier: HostKeyVerifier,
    pool?: AgentSshClientPool
  ) {
    this.pool = pool ?? new AgentSshClientPool(configManager, hostKeyVerifier);
  }

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
      let lease: AgentSshClientLease | undefined;
      // Armed before acquisition so the caller's timeout still covers a connection that
      // never comes up, not just a command that never returns.
      const timeout = setTimeout(() => {
        timedOut = true;
        stream?.close();
        finish(null);
      }, timeoutMs);

      const onAbort = (): void => {
        // Ask the remote side to terminate first; closing the channel alone can leave an
        // interactive command or its children running server-side.
        try {
          stream?.signal('TERM');
        } catch {
          // The channel may already be gone; closing it below is still correct.
        }
        stream?.close();
        rejectOnce(new Error('Remote command was cancelled.'));
      };

      const onConnectionLost = (error?: Error): void => {
        rejectOnce(error ?? new Error('SSH connection closed before the command finished.'));
      };
      const detach = (): void => {
        clearTimeout(timeout);
        request.signal?.removeEventListener('abort', onAbort);
        if (!lease) {
          return;
        }
        lease.client.off('error', onConnectionLost);
        lease.client.off('close', onConnectionLost);
        lease.release();
      };
      if (request.signal) {
        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

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
          // A timeout appends its notice instead of replacing stderr: whatever the
          // command managed to print before it overran is usually the diagnosis.
          stderr: timedOut ? appendTimeoutNotice(stderr.text(), timeoutMs) : stderr.text(),
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

  /** Closes the pooled connection for one server, e.g. after its configuration changed. */
  disposeServer(serverId: string): void {
    this.pool.disposeServer(serverId);
  }

  /** Closes every pooled connection. Must run on extension deactivate. */
  dispose(): void {
    this.disposed = true;
    this.pool.dispose();
  }

  private async acquire(server: ServerConfig): Promise<AgentSshClientLease> {
    if (this.disposed) {
      throw new Error('The remote command executor has been disposed.');
    }
    return await this.pool.acquire(server);
  }
}

function appendTimeoutNotice(capturedStderr: string, timeoutMs: number): string {
  const notice = `Command timed out after ${timeoutMs}ms.`;
  if (!capturedStderr) {
    return notice;
  }
  return capturedStderr.endsWith('\n') ? `${capturedStderr}${notice}` : `${capturedStderr}\n${notice}`;
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
    const combined = Buffer.concat(this.chunks);
    return (this.truncated ? alignUtf8Boundary(combined) : combined).toString('utf8');
  }
}

/**
 * A hard byte cap can land inside a multi-byte UTF-8 character, which decodes to a
 * trailing replacement character (U+FFFD). When truncating, walk back over at most three
 * continuation bytes and drop the whole partial character instead.
 */
export function alignUtf8Boundary(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuationBytes = 0;
  while (index >= 0 && (buffer[index]! & 0xc0) === 0x80 && continuationBytes < 4) {
    continuationBytes += 1;
    index -= 1;
  }
  if (index < 0) {
    return buffer.subarray(0, buffer.length - continuationBytes);
  }
  const lead = buffer[index]!;
  const expectedLength =
    lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  if (expectedLength === 1) {
    return buffer.subarray(0, index + 1);
  }
  if (continuationBytes + 1 < expectedLength) {
    return buffer.subarray(0, index);
  }
  return buffer;
}
