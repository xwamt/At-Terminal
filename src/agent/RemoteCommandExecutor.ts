import { Client, type ClientChannel } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { quotePosixShellPath } from '../sftp/RemotePath';
import { buildSshConnectConfig, type HostKeyVerifier } from '../ssh/SshConnectionConfig';

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

export class RemoteCommandExecutor {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier?: HostKeyVerifier
  ) {}

  async execute(server: ServerConfig, request: RemoteCommandRequest): Promise<RemoteCommandResult> {
    const command = request.command.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }

    const timeoutMs = clampPositiveInteger(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxOutputBytes = clampPositiveInteger(request.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const started = Date.now();
    const client = new Client();
    const execCommand = wrapCommand(command, request.cwd);
    let stream: ClientChannel | undefined;
    let settled = false;
    let timedOut = false;

    const finish = (
      resolve: (value: RemoteCommandResult) => void,
      stdout: OutputBuffer,
      stderr: OutputBuffer,
      exitCode: number | null,
      signal?: string
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      client.end();
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
    };

    const config = await buildSshConnectConfig(server, this.configManager, this.hostKeyVerifier);

    return new Promise<RemoteCommandResult>((resolve, reject) => {
      const stdout = new OutputBuffer(maxOutputBytes);
      const stderr = new OutputBuffer(maxOutputBytes);
      const timeout = setTimeout(() => {
        timedOut = true;
        stream?.close();
        finish(resolve, stdout, stderr, null);
      }, timeoutMs);

      const rejectOnce = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        client.end();
        reject(error);
      };

      client.once('ready', () => {
        client.exec(execCommand, (error, execStream) => {
          if (error) {
            rejectOnce(error);
            return;
          }

          stream = execStream;
          execStream.on('data', (data: Buffer) => stdout.append(data));
          execStream.stderr.on('data', (data: Buffer) => stderr.append(data));
          execStream.once('close', (code: number | null, signalName?: string) => {
            clearTimeout(timeout);
            finish(resolve, stdout, stderr, code, signalName);
          });
        });
      });
      client.once('error', rejectOnce);
      client.connect(config);
    });
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
  if (!Number.isInteger(value) || value <= 0) {
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
