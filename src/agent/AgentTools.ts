import * as vscode from 'vscode';
import { AgentToolService, type RunRemoteCommandInput } from './AgentToolService';

export function registerAgentTools(service: AgentToolService): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('list_ssh_servers', new JsonTool<object>(() => service.listServers())),
    vscode.lm.registerTool('get_terminal_context', new JsonTool<object>(() => service.getTerminalContext())),
    vscode.lm.registerTool(
      'run_remote_command',
      new JsonTool<RunRemoteCommandInput>((input) => service.runRemoteCommand(input))
    )
  ];
}

class JsonTool<TInput extends object> implements vscode.LanguageModelTool<TInput> {
  constructor(private readonly invokeJson: (input: TInput) => Promise<unknown>) {}

  async invoke(options: vscode.LanguageModelToolInvocationOptions<TInput>): Promise<vscode.LanguageModelToolResult> {
    return jsonToolResult(await this.invokeJson((options.input ?? {}) as TInput));
  }
}

function jsonToolResult(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}
