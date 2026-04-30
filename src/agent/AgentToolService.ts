import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry, TerminalContextSnapshot } from '../terminal/TerminalContext';
import type { RemoteCommandExecutor, RemoteCommandResult } from './RemoteCommandExecutor';

export interface AgentToolServiceDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
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
      servers: servers.map((server) => ({
        id: server.id,
        label: server.label,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType
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
    const warning = isObviouslyDestructive(command) ? '\n\nWarning: this command appears destructive.' : '';
    const answer = await vscode.window.showWarningMessage(
      `Run remote command on ${server.label} (${server.host})?\n\n${command}${warning}`,
      { modal: true },
      'Run Command'
    );
    if (answer !== 'Run Command') {
      throw new Error('Remote command was cancelled.');
    }
    return await this.dependencies.executor.execute(server, {
      command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes
    });
  }

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const connected = this.dependencies.terminalContext.getConnectedTerminal();
      if (connected) {
        return connected.server;
      }
      if (serverId === 'active') {
        throw new Error('No connected active SSH terminal is available.');
      }
    }
    if (!serverId) {
      throw new Error('serverId is required when there is no connected active SSH terminal.');
    }
    const server = await this.dependencies.configManager.getServer(serverId);
    if (!server) {
      throw new Error(`SSH server "${serverId}" was not found.`);
    }
    return server;
  }
}

function isObviouslyDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
