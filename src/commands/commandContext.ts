import type * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { SftpAgentService } from '../agent/SftpAgentService';
import type { SftpEditSessionManager } from '../sftp/SftpEditSessionManager';
import type { SftpManager } from '../sftp/SftpManager';
import type { SftpPreviewDocumentStore } from '../sftp/SftpPreview';
import type { HostKeyStore } from '../ssh/HostKeyStore';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import type { PortForwardManager } from '../ssh/PortForwardManager';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import type { ServerTreeProvider } from '../tree/ServerTreeProvider';
import type { SftpTreeProvider } from '../tree/SftpTreeProvider';

/**
 * Services every command module needs. Created once in `activate()`; command modules stay
 * free of activation ordering and only register their own commands.
 */
export interface CommandContext {
  context: vscode.ExtensionContext;
  configManager: ConfigManager;
  hostKeyStore: HostKeyStore;
  hostKeyVerifier: HostKeyVerifier;
  terminalContext: TerminalContextRegistry;
  treeProvider: ServerTreeProvider;
  sftpManager: SftpManager;
  sftpTreeProvider: SftpTreeProvider;
  sftpEditManager: SftpEditSessionManager;
  sftpPreviewStore: SftpPreviewDocumentStore;
  portForwardManager: PortForwardManager;
  getSftpAgentService(): SftpAgentService | undefined;
  getRemoteCommandExecutor(): { disposeServer(serverId: string): void };
}
