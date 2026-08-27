import { appendFile, mkdir } from 'node:fs/promises';
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
}

export interface AgentAuditLogOptions {
  /** Directory the JSONL file lives in; production passes `globalStorageUri.fsPath`. */
  storageDir: string;
  channel: AgentAuditChannel;
  now?: () => number;
  fs?: AgentAuditFileSystem;
}

/** The slice of the audit log that tool services depend on. */
export type AgentAuditRecorder = Pick<AgentAuditLog, 'record'>;

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
  /** Serializes appends so concurrent tool calls cannot interleave half-lines. */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: AgentAuditLogOptions) {
    this.filePath = join(options.storageDir, AGENT_AUDIT_FILE_NAME);
    this.channel = options.channel;
    this.now = options.now ?? Date.now;
    this.fs = options.fs ?? { mkdir, appendFile };
  }

  /** Fire-and-forget: an audit failure must never fail the tool call it describes. */
  record(entry: AgentAuditEntry): void {
    const line = JSON.stringify({
      time: new Date(this.now()).toISOString(),
      ...entry,
      ...(entry.command === undefined ? {} : { command: redactSensitiveText(entry.command) })
    });
    this.channel.appendLine(line);
    this.tail = this.tail
      .then(async () => {
        await this.fs.mkdir(dirname(this.filePath), { recursive: true });
        await this.fs.appendFile(this.filePath, `${line}\n`, 'utf8');
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
}

/** Production wiring: OutputChannel plus a JSONL file under the extension's global storage. */
export function createAgentAuditLog(globalStorageUri: { fsPath: string }): AgentAuditLog {
  return new AgentAuditLog({
    storageDir: globalStorageUri.fsPath,
    channel: vscode.window.createOutputChannel(AGENT_AUDIT_CHANNEL_NAME)
  });
}
