import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import { formatRemoteCommandConfirmMessage } from '../utils/commandPreview';
import type { RemoteCommandExecutor, RemoteCommandResult } from './RemoteCommandExecutor';
import type { SftpAgentService } from './SftpAgentService';

export interface AgentToolServiceDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
  sftp?: SftpAgentService;
}

export interface RunRemoteCommandInput {
  serverId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

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
        agentCommandAutoApprove: server.agentCommandAutoApprove === true
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
    const server = await this.resolveServer(input.serverId);
    const destructive = isObviouslyDestructive(command);
    const needsConfirmation = server.agentCommandAutoApprove !== true || destructive;
    if (needsConfirmation) {
      const answer = await vscode.window.showWarningMessage(
        formatRemoteCommandConfirmMessage({
          serverLabel: server.label,
          host: server.host,
          command,
          destructive
        }),
        { modal: true },
        'Run Command'
      );
      if (answer !== 'Run Command') {
        throw new Error('Remote command was cancelled.');
      }
    }
    return await this.dependencies.executor.execute(server, {
      command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes
    });
  }

  async sftpListDirectory(input: { terminalId?: string; serverId?: string; path?: string }) {
    return await this.requireSftp().listDirectory(input);
  }

  async sftpStatPath(input: { terminalId?: string; serverId?: string; path: string }) {
    return await this.requireSftp().statPath(input);
  }

  async sftpReadFile(input: { terminalId?: string; serverId?: string; path: string; maxBytes?: number }) {
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

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (connected) {
        // Live UI terminal connection is enough; background auth is only for no-UI paths.
        return connected.server;
      }
      if (serverId === 'active') {
        throw new Error('No connected active SSH terminal is available.');
      }
    }

    if (serverId && serverId !== 'active') {
      const connectedByServer = this.dependencies.terminalContext.getConnectedTerminalByServerId(serverId);
      if (connectedByServer) {
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
      throw new Error(`SSH server "${server.id}" does not allow background connections.`);
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

function isObviouslyDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
