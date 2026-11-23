import * as vscode from 'vscode';
import { detectHostApp } from '@at-series/mcp-hub';
import { AgentToolService } from '../agent/AgentToolService';
import type { AgentSshClientPool } from '../agent/AgentSshClientPool';
import { createAgentAuditLog, type AgentAuditLog } from '../agent/AgentAuditLog';
import type { RemoteCommandExecutor } from '../agent/RemoteCommandExecutor';
import { SftpAgentService } from '../agent/SftpAgentService';
import { createProductionSftpWriteAuthorizer } from '../agent/createSftpWriteAuthorizer';
import type { ConfigManager } from '../config/ConfigManager';
import { BridgeServer } from './BridgeServer';
import { syncPackagedHub } from './hubSync';
import { ensureAtSeriesConfigForCurrentIde } from './McpConfigInstaller';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { SftpSession } from '../sftp/SftpSession';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { showErrorWithActions } from '../utils/notifications';
import { t } from '../i18n/t';

export interface McpActivationOptions {
  context: vscode.ExtensionContext;
  configManager: ConfigManager;
  hostKeyVerifier: HostKeyVerifier;
  terminalContext: TerminalContextRegistry;
  remoteCommandExecutor: RemoteCommandExecutor;
  agentSshClientPool: AgentSshClientPool;
}

export interface McpActivationResult {
  sftpAgentService: SftpAgentService;
  bridgeServer: BridgeServer;
  agentAuditLog: AgentAuditLog;
  hostEnv: {
    appName: string;
    appRoot: string;
    uriScheme: string;
    extensionPath: string;
  };
  currentWorkspaceFolder(): string | undefined;
}

/**
 * Starts the MCP bridge and the agent tool services. `MCP_ENABLED` is a build-time global
 * so the base build tree-shakes this whole module; callers only run it for the MCP variant.
 *
 * Order: detectHostApp → syncPackagedHub → AgentToolService → BridgeServer.start (publish)
 * → ensureAtSeriesConfig. Commands are registered separately by `registerMcpCommands`.
 */
export function activateMcp(options: McpActivationOptions): McpActivationResult {
  const { context, configManager, hostKeyVerifier, terminalContext, remoteCommandExecutor } = options;
  const hostEnv = {
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionUri.fsPath
  };
  const hostApp = detectHostApp(hostEnv);
  const currentWorkspaceFolder = (): string | undefined =>
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Await hub sync before writing MCP config so node can resolve ~/.at-series/mcp/hub.js.
  const hubReady = syncPackagedHub(context)
    .then((result) => {
      console.log(
        `AT Terminal hub sync ok (updated=${result.updated}, active=${result.activeVersion})`
      );
      return result;
    })
    .catch((error) => {
      console.error('AT Terminal hub sync failed:', formatError(error));
      const repairAction = t('Repair');
      void showErrorWithActions(
        t('AT Series hub sync failed: {message}. MCP may not start until Repair succeeds.', {
          message: formatError(error)
        }),
        repairAction
      ).then((choice) => {
        if (choice === repairAction) {
          void vscode.commands.executeCommand('sshManager.installMcpConfig');
        }
      });
      throw error;
    });

  const sftpWriteAuthorizer = createProductionSftpWriteAuthorizer();
  const agentAuditLog = createAgentAuditLog(context.globalStorageUri);
  const sftpAgentService = new SftpAgentService({
    terminalContext,
    // Agent writes never escalate: a denied write stays denied instead of silently
    // becoming a root write through the sudo fallback.
    createSession: (target) =>
      new SftpSession(target.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
    // Background SFTP rides the same authenticated client as run_remote_command: one
    // SSH handshake (and one 2FA prompt) per server per conversation, not two.
    createBackgroundSession: (target) =>
      new SftpSession(target.server, configManager, hostKeyVerifier, {
        allowSudoFallback: false,
        acquireClient: () => options.agentSshClientPool.acquire(target.server)
      }),
    authorizer: sftpWriteAuthorizer,
    resolveBackgroundServer: (serverId) => configManager.getServer(serverId),
    audit: agentAuditLog
  });
  const agentToolService = new AgentToolService({
    configManager,
    terminalContext,
    executor: remoteCommandExecutor,
    sftp: sftpAgentService,
    audit: agentAuditLog
  });
  const bridgeServer = new BridgeServer({
    service: agentToolService,
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string'
        ? context.extension.packageJSON.version
        : undefined
  });
  void bridgeServer.start().catch((error) => {
    void showErrorWithActions(
      t('AT Terminal MCP bridge failed to start: {message}', { message: formatError(error) })
    );
  });
  void hubReady
    .then(() =>
      ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      })
    )
    .catch((error) => {
      const repairAction = t('Repair');
      void showErrorWithActions(
        t('AT Series MCP config could not be updated: {message}', { message: formatError(error) }),
        repairAction
      ).then((choice) => {
        if (choice === repairAction) {
          void vscode.commands.executeCommand('sshManager.installMcpConfig');
        }
      });
    });

  return { sftpAgentService, bridgeServer, agentAuditLog, hostEnv, currentWorkspaceFolder };
}
