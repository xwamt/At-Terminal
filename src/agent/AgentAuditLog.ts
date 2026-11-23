import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { redactSensitiveText } from '../utils/redaction';

export const AGENT_AUDIT_CHANNEL_NAME = 'AT Terminal Agent Audit';
export const AGENT_AUDIT_FILE_NAME = 'agent-audit.jsonl';

/**
 * One agent tool invocation. `command` and `path` are alternatives depending on the
 * tool; both may be present for tools that carry both (none today).
 */
export interface AgentAuditEntry {
  serverId?: string;
  terminalId?: string;
  tool: string;
  command?: string;
  path?: string;
  /** Why the call was allowed, refused, or how it ended (e.g. auto_approved, user_cancelled). */
  reasonCode: string;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
}

export interface AgentAuditChannel {
  appendLine(line: string): void;
  dispose?(): void;
}

export interface AgentAuditFileSystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  /** Optional so test doubles can keep the pre-rotation surface. */
  stat?(path: string): Promise<{ size: number }>;
  rename?(oldPath: string, newPath: string): Promise<void>;
  rm?(path: string, options: { force: true }): Promise<void>;
}

export interface AgentAuditLogOptions {
  /** Directory the JSONL file lives in; production passes `globalStorageUri.fsPath`. */
  storageDir: string;
  channel: AgentAuditChannel;
  now?: () => number;
  fs?: AgentAuditFileSystem;
  /** Rotate `agent-audit.jsonl` once it would grow past this size. Default 10 MiB. */
  maxBytes?: number;
}

/** The slice of the audit log that tool services depend on. */
export type AgentAuditRecorder = Pick<AgentAuditLog, 'record'>;

export const AGENT_AUDIT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * After-the-fact evidence for full-trust and background agent activity: every tool call
 * lands in an OutputChannel the user can watch and a JSONL file that survives the
 * session. Command text is redacted before it is written anywhere.
 */
export class AgentAuditLog {
  private readonly filePath: string;
  private readonly channel: AgentAuditChannel;
  private readonly now: () => number;
  private readonly fs: AgentAuditFileSystem;
  private readonly maxBytes: number;
  /** Serializes appends so concurrent tool calls cannot interleave half-lines. */
  private tail: Promise<void> = Promise.resolve();
  /** The storage directory is created once; ENOENT from append resets this. */
  private dirEnsured = false;
  /** Bytes already in the current file; undefined until first measured. */
  private fileBytes: number | undefined;

  constructor(options: AgentAuditLogOptions) {
    this.filePath = join(options.storageDir, AGENT_AUDIT_FILE_NAME);
    this.channel = options.channel;
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? { mkdir, appendFile, stat, rename, rm };
    this.maxBytes = options.maxBytes ?? AGENT_AUDIT_MAX_BYTES;
  }

  /** Fire-and-forget: an audit failure must never fail the tool call it describes. */
  record(entry: AgentAuditEntry): void {
    const line = JSON.stringify({
      time: new Date(this.now()).toISOString(),
      ...entry,
      ...(entry.command === undefined ? {} : { command: redactSensitiveText(entry.command) })
    });
    this.channel.appendLine(line);
    const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    this.tail = this.tail
      .then(async () => {
        await this.ensureDirectory();
        await this.rotateIfNeeded(bytes);
        try {
          await this.fs.appendFile(this.filePath, `${line}\n`, 'utf8');
        } catch (error) {
          // A directory removed behind our back surfaces as ENOENT; recreate once.
          if (!isEnoent(error)) {
            throw error;
          }
          this.dirEnsured = false;
          await this.ensureDirectory();
          await this.fs.appendFile(this.filePath, `${line}\n`, 'utf8');
        }
        this.fileBytes = (this.fileBytes ?? 0) + bytes;
      })
      .catch(() => undefined);
  }

  /** Resolves once every entry recorded so far has been written to disk. */
  async flush(): Promise<void> {
    await this.tail;
  }

  dispose(): void {
    this.channel.dispose?.();
  }

  private async ensureDirectory(): Promise<void> {
    if (this.dirEnsured) {
      return;
    }
    await this.fs.mkdir(dirname(this.filePath), { recursive: true });
    this.dirEnsured = true;
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    if (!this.fs.rename) {
      return;
    }
    if (this.fileBytes === undefined) {
      try {
        this.fileBytes = (await this.fs.stat?.(this.filePath))?.size ?? 0;
      } catch {
        this.fileBytes = 0;
      }
    }
    if (this.fileBytes === 0 || this.fileBytes + incomingBytes <= this.maxBytes) {
      return;
    }
    const backupPath = `${this.filePath}.1`;
    await this.fs.rm?.(backupPath, { force: true }).catch(() => undefined);
    await this.fs.rename(this.filePath, backupPath);
    this.fileBytes = 0;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Production wiring: OutputChannel plus a JSONL file under the extension's global storage. */
export function createAgentAuditLog(globalStorageUri: { fsPath: string }): AgentAuditLog {
  return new AgentAuditLog({
    storageDir: globalStorageUri.fsPath,
    channel: vscode.window.createOutputChannel(AGENT_AUDIT_CHANNEL_NAME)
  });
}
