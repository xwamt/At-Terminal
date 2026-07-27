import * as vscode from 'vscode';
import { AgentToolService, type RunRemoteCommandInput } from './AgentToolService';

export function registerAgentTools(service: AgentToolService): vscode.Disposable[] {
  return [
    vscode.lm.registerTool('list_ssh_servers', new JsonTool<object>(() => service.listServers())),
    vscode.lm.registerTool('get_terminal_context', new JsonTool<object>(() => service.getTerminalContext())),
    vscode.lm.registerTool(
      'run_remote_command',
      new JsonTool<RunRemoteCommandInput>((input) => service.runRemoteCommand(input))
    ),
    vscode.lm.registerTool('sftp_list_directory', new JsonTool((input) => service.sftpListDirectory(input as never))),
    vscode.lm.registerTool('sftp_stat_path', new JsonTool((input) => service.sftpStatPath(input as never))),
    vscode.lm.registerTool('sftp_read_file', new JsonTool((input) => service.sftpReadFile(input as never))),
    vscode.lm.registerTool('sftp_write_file', new JsonTool((input) => service.sftpWriteFile(input as never))),
    vscode.lm.registerTool('sftp_create_file', new JsonTool((input) => service.sftpCreateFile(input as never))),
    vscode.lm.registerTool(
      'sftp_create_directory',
      new JsonTool((input) => service.sftpCreateDirectory(input as never))
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
