import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { t } from '../i18n/t';
import type { TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import { formatRemoteCommandConfirmMessage } from '../utils/commandPreview';
import type { AgentAuditRecorder } from './AgentAuditLog';
import type { RemoteCommandExecutor, RemoteCommandResult } from './RemoteCommandExecutor';
import { authorizeRemoteCommand, resolveAgentCommandTrust } from './agentCommandTrust';
import type { SftpAgentService } from './SftpAgentService';

export interface AgentToolServiceDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
  sftp?: SftpAgentService;
  audit?: AgentAuditRecorder;
}

export interface RunRemoteCommandInput {
  serverId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * A modal the user never answers must not park the agent forever: after this long the
 * tool call fails with an instruction to get the human to the IDE.
 */
const CONFIRMATION_TIMEOUT_MS = 120_000;

export class AgentToolService {
  constructor(private readonly dependencies: AgentToolServiceDependencies) {}

  async listServers() {
    const servers = await this.dependencies.configManager.listServers();
    return {
      servers: servers.filter((server) => server.backgroundConnectionAllowed === true).map((server) => ({
        id: server.id,
        label: server.label,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        agentCommandTrust: resolveAgentCommandTrust(server),
        agentCommandAutoApprove: resolveAgentCommandTrust(server) !== 'none'
      }))
    };
  }

  async getTerminalContext(): Promise<TerminalContextSnapshot> {
    return this.dependencies.terminalContext.getSnapshot();
  }

  async runRemoteCommand(input: RunRemoteCommandInput): Promise<RemoteCommandResult> {
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }
    const started = Date.now();
    let reasonCode = 'auto_approved';
    try {
      const server = await this.resolveServer(input.serverId);
      const authorization = await authorizeRemoteCommand({
        server,
        command,
        cwd: input.cwd
      });
      if (!authorization.autoApprove) {
        const runCommandLabel = t('Run Command');
        const answer = await withTimeout(
          Promise.resolve(
            vscode.window.showWarningMessage(
              formatRemoteCommandConfirmMessage({
                serverLabel: server.label,
                host: server.host,
                command,
                destructive: authorization.destructive,
                riskSummaries: authorization.riskSummaries
              }),
              { modal: true },
              runCommandLabel
            )
          ),
          CONFIRMATION_TIMEOUT_MS,
          'Confirmation timed out; ask the user to approve the command dialog in the IDE, then retry.'
        );
        if (answer !== runCommandLabel) {
          reasonCode = 'user_cancelled';
          throw new Error('Remote command was cancelled.');
        }
        reasonCode = 'user_approved';
      }
      const result = await this.dependencies.executor.execute(server, {
        command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes
      });
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: result.serverId,
        command,
        reasonCode: result.timedOut ? 'command_timeout' : reasonCode,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        truncated: result.truncated
      });
      return result;
    } catch (error) {
      this.dependencies.audit?.record({
        tool: 'run_remote_command',
        serverId: input.serverId,
        command,
        reasonCode: auditReasonForError(error, reasonCode),
        durationMs: Date.now() - started
      });
      throw error;
    }
  }

  async sftpListDirectory(input: {
    terminalId?: string;
    serverId?: string;
    path?: string;
    maxEntries?: number;
    offset?: number;
  }) {
    return await this.requireSftp().listDirectory(input);
  }

  async sftpStatPath(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().statPath(input);
  }

  async sftpReadFile(input: {
    terminalId?: string;
    serverId?: string;
    path: string;
    maxBytes?: number;
    offset?: number;
  }) {
    return await this.requireSftp().readFile(input);
  }

  async sftpWriteFile(input: {
    terminalId?: string;
    serverId?: string;
    path: string;
    content: string;
    overwrite?: boolean;
  }) {
    return await this.requireSftp().writeFile(input);
  }

  async sftpCreateFile(input: { terminalId?: string; serverId?: string; path: string; content?: string }) {
    return await this.requireSftp().createFile(input);
  }

  async sftpCreateDirectory(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().createDirectory(input);
  }

  async sftpRename(input: { terminalId?: string; serverId?: string; path: string; newPath: string }) {
    return await this.requireSftp().rename(input);
  }

  async sftpDelete(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().deleteFile(input);
  }

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (connected) {
        // Live UI terminal connection is enough; background auth is only for no-UI paths.
        const latest = await this.dependencies.configManager.getServer(connected.server.id);
        if (latest) {
          this.dependencies.terminalContext.updateServer(latest);
          return latest;
        }
        return connected.server;
      }
      if (serverId === 'active') {
        throw new Error('No connected active SSH terminal is available.');
      }
    }

    if (serverId && serverId !== 'active') {
      const connectedByServer = this.dependencies.terminalContext.getConnectedTerminalByServerId(serverId);
      if (connectedByServer) {
        const latest = await this.dependencies.configManager.getServer(connectedByServer.server.id);
        if (latest) {
          this.dependencies.terminalContext.updateServer(latest);
          return latest;
        }
        return connectedByServer.server;
      }
    }

    if (!serverId) {
      throw new Error('serverId is required when there is no connected active SSH terminal.');
    }

    const server = await this.dependencies.configManager.getServer(serverId);
    if (!server) {
      throw new Error(`SSH server "${serverId}" was not found.`);
    }
    return this.requireBackgroundConnectionAllowed(server);
  }

  private requireBackgroundConnectionAllowed(server: ServerConfig): ServerConfig {
    if (server.backgroundConnectionAllowed !== true) {
      throw new Error(
        `SSH server "${server.id}" does not allow background connections. ` +
          'Ask the user to enable "Allow background connections" on the AT Terminal server edit form, ' +
          'or connect an AT Terminal session to that server.'
      );
    }
    return server;
  }

  private requireSftp(): SftpAgentService {
    if (!this.dependencies.sftp) {
      throw new Error('AT Terminal SFTP agent service is not available.');
    }
    return this.dependencies.sftp;
  }
}

function auditReasonForError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('was cancelled')) {
    return 'user_cancelled';
  }
  if (message.startsWith('Confirmation timed out')) {
    return 'confirmation_timeout';
  }
  if (message.includes('does not allow background connections')) {
    return 'background_denied';
  }
  return fallback === 'user_approved' || fallback === 'auto_approved' ? 'error' : fallback;
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
