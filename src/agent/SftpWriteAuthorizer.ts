import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

export interface SftpWriteRequest {
  operation: 'write_file' | 'create_file' | 'create_directory';
  path: string;
  overwrite: boolean;
}

export type ConfirmSftpWrite = (server: ServerConfig, request: SftpWriteRequest) => Promise<boolean>;

export class SftpWriteAuthorizer {
  private readonly approvedServerIds = new Set<string>();

  constructor(private readonly confirm: ConfirmSftpWrite = confirmWithVscode) {}

  async requireWrite(server: ServerConfig, request: SftpWriteRequest): Promise<void> {
    if (this.approvedServerIds.has(server.id)) {
      return;
    }
    if (!(await this.confirm(server, request))) {
      throw new Error('SFTP write was cancelled.');
    }
    this.approvedServerIds.add(server.id);
  }
}

async function confirmWithVscode(server: ServerConfig, request: SftpWriteRequest): Promise<boolean> {
  const overwrite = request.overwrite ? '\nOverwrite: yes' : '\nOverwrite: no';
  const answer = await vscode.window.showWarningMessage(
    `Allow AT Terminal agent SFTP write on ${server.label} (${server.host})?\n\nOperation: ${request.operation}\nPath: ${request.path}${overwrite}`,
    { modal: true },
    'Allow SFTP Write'
  );
  return answer === 'Allow SFTP Write';
}
