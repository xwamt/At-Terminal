import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import type { RemoteCommandExecutor } from './RemoteCommandExecutor';

export interface AgentToolDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
}

interface RunRemoteCommandInput {
  serverId?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export function registerAgentTools(dependencies: AgentToolDependencies): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('sshManager.listServers', new ListServersTool(dependencies.configManager)),
    vscode.lm.registerTool('sshManager.runRemoteCommand', new RunRemoteCommandTool(dependencies))
  ];
}

class ListServersTool implements vscode.LanguageModelTool<object> {
  constructor(private readonly configManager: ConfigManager) {}

  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const servers = await this.configManager.listServers();
    return jsonToolResult({
      servers: servers.map((server) => ({
        id: server.id,
        label: server.label,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType
      }))
    });
  }
}

class RunRemoteCommandTool implements vscode.LanguageModelTool<RunRemoteCommandInput> {
  constructor(private readonly dependencies: AgentToolDependencies) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunRemoteCommandInput>
  ): Promise<vscode.LanguageModelToolResult> {
    const input = options.input ?? {};
    const command = input.command?.trim();
    if (!command) {
      throw new Error('Remote command cannot be empty.');
    }

    const server = await this.resolveServer(input.serverId);
    const answer = await vscode.window.showWarningMessage(
      `Run remote command on ${server.label} (${server.host})?\n\n${command}`,
      { modal: true },
      'Run Command'
    );
    if (answer !== 'Run Command') {
      throw new Error('Remote command was cancelled.');
    }

    const result = await this.dependencies.executor.execute(server, {
      command,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: input.maxOutputBytes
    });
    return jsonToolResult(result);
  }

  private async resolveServer(serverId: string | undefined): Promise<ServerConfig> {
    if (serverId === 'active' || !serverId) {
      const active = this.dependencies.terminalContext.getActive();
      if (active?.connected) {
        return active.server;
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

function jsonToolResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}
