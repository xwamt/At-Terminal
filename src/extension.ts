import * as vscode from 'vscode';
import { AgentSshClientPool } from './agent/AgentSshClientPool';
import { RemoteCommandExecutor } from './agent/RemoteCommandExecutor';
import { ConfigManager } from './config/ConfigManager';
import type { CommandContext } from './commands/commandContext';
import { registerMcpCommands } from './commands/mcpCommands';
import { refreshPortForwardStatusBar, registerPortForwardCommands } from './commands/portForwardCommands';
import { registerServerCommands } from './commands/serverCommands';
import { registerSftpCommands } from './commands/sftpCommands';
import { activateMcp, type McpActivationResult } from './mcp/activateMcp';
import { HostKeyStore } from './ssh/HostKeyStore';
import { attachKeyboardInteractive } from './ssh/KeyboardInteractive';
import { buildSshConnectionHandle, disposeJumpHostConnections } from './ssh/SshConnectionConfig';
import { getSsh2 } from './ssh/ssh2Loader';
import { createVscodeKeyboardInteractivePrompt } from './ssh/VscodeKeyboardInteractivePrompt';
import { PortForwardManager } from './ssh/PortForwardManager';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { createHostKeyVerifier, serverConnectionStates } from './extension/serverHelpers';
import { ServerTreeProvider } from './tree/ServerTreeProvider';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { GroupTreeItem } from './tree/TreeItems';
import { createVscodeSftpEditUi, resolveEditStorageUri, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
import { SftpManager } from './sftp/SftpManager';
import { cleanupPreviewCache, SFTP_PREVIEW_SCHEME, SftpPreviewDocumentStore } from './sftp/SftpPreview';
import { SftpSession } from './sftp/SftpSession';
import { SftpDragAndDropController } from './sftp/SftpDragAndDropController';
import { VscodeTransferReporter } from './sftp/VscodeTransferReporter';
import { TerminalPanel } from './webview/TerminalPanel';
import { SftpDirectoryTreeItem } from './tree/SftpTreeItems';
import { formatError } from './utils/errors';
import { createRegistryBackedSftpTreeSource, registerSftpContextWiring } from './extension/wiring';
let extensionCleanup: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigManager(context.globalState, context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new ServerTreeProvider(configManager, () =>
    serverConnectionStates(terminalContext.getSnapshot().knownTerminals)
  );
  const hostKeyVerifier = createHostKeyVerifier(hostKeyStore);

  const portForwardStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  const refreshPortForwardStatus = (): void => {
    refreshPortForwardStatusBar(portForwardStatus, portForwardManager.list());
  };
  const portForwardManager = new PortForwardManager({
    createConnection: async (server) => {
      const prompt = createVscodeKeyboardInteractivePrompt();
      const handle = await buildSshConnectionHandle(server, configManager, hostKeyVerifier, {
        keyboardInteractivePrompt: prompt
      });
      const { Client } = await getSsh2();
      const client = new Client();
      client.on('error', () => undefined);
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('ready', resolve);
          client.once('error', reject);
          attachKeyboardInteractive(client, prompt, reject);
          client.connect(handle.config);
        });
      } catch (error) {
        client.end();
        handle.dispose();
        throw error;
      }
      return { client, handle };
    },
    onChange: () => refreshPortForwardStatus(),
    notify: (message) => void vscode.window.showWarningMessage(message)
  });

  const sftpManager = new SftpManager({
    // The SFTP view is driven by the user, so a denied write may retry under sudo.
    createSession: (terminal) =>
      new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: true }),
    reporter: new VscodeTransferReporter()
  });
  const sftpTreeProvider = new SftpTreeProvider(
    createRegistryBackedSftpTreeSource(terminalContext, sftpManager)
  );
  // Attach the tree data providers before any other activation work (MCP wiring,
  // command registration). Until a provider is attached, VS Code shows the
  // viewsWelcome placeholder ("no servers configured"), so a slow activation —
  // typical right after a VSIX install/update — made persisted servers look
  // lost until the window was reloaded.
  const serversTreeView = vscode.window.createTreeView('sshManager.servers', {
    treeDataProvider: treeProvider,
    showCollapseAll: true
  });
  const sftpTreeView = vscode.window.createTreeView('sshManager.sftpFiles', {
    treeDataProvider: sftpTreeProvider,
    dragAndDropController: new SftpDragAndDropController(sftpManager, {
      onUploaded: (target) =>
        sftpTreeProvider.refresh(target instanceof SftpDirectoryTreeItem ? target : undefined)
    }),
    showCollapseAll: true
  });
  const sftpPreviewStore = new SftpPreviewDocumentStore();
  const sftpEditStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sftpEditManager = new SftpEditSessionManager({
    storageUri: resolveEditStorageUri(context.globalStorageUri, vscode.workspace.workspaceFolders),
    sftp: sftpManager,
    ui: createVscodeSftpEditUi(sftpEditStatus)
  });
  const agentSshClientPool = new AgentSshClientPool(configManager, hostKeyVerifier);
  const remoteCommandExecutor = new RemoteCommandExecutor(configManager, hostKeyVerifier, agentSshClientPool);

  let mcp: McpActivationResult | undefined;
  let disposed = false;
  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      TerminalPanel.disconnectAll();
      sftpManager.dispose();
      remoteCommandExecutor.dispose();
      disposeJumpHostConnections();
      // Preview downloads are a cache; leaving them behind after an uninstall/update
      // otherwise accumulates copies of sensitive remote files in global storage.
      void cleanupPreviewCache(context.globalStorageUri.fsPath);
      void portForwardManager.dispose();
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
    }
  };
  extensionCleanup = cleanup;

  registerSftpContextWiring({
    terminalContext,
    sftpManager,
    refreshSftpTree: () => sftpTreeProvider.refresh(),
    onTerminalsChanged: () => {
      // Connection state feeds the Servers tree icon/description.
      treeProvider.refresh();
      // Connect/disconnect must reach the ~/.at-series registry immediately, not on the
      // next 30s heartbeat, or hub routing sees 0 connected terminals.
      void mcp?.bridgeServer.refreshCapabilities();
    },
    onTerminalRemoved: (terminalId) => mcp?.sftpAgentService.disposeTerminal(terminalId)
  });

  if (MCP_ENABLED) {
    mcp = activateMcp({
      context,
      configManager,
      hostKeyVerifier,
      terminalContext,
      remoteCommandExecutor,
      agentSshClientPool
    });
  }

  const commandContext: CommandContext = {
    context,
    configManager,
    hostKeyStore,
    hostKeyVerifier,
    terminalContext,
    treeProvider,
    sftpManager,
    sftpTreeProvider,
    sftpEditManager,
    sftpPreviewStore,
    portForwardManager,
    getSftpAgentService: () => mcp?.sftpAgentService,
    getRemoteCommandExecutor: () => remoteCommandExecutor
  };
  const commandDisposables = [
    ...registerServerCommands(commandContext),
    ...registerSftpCommands(commandContext),
    ...registerPortForwardCommands(commandContext)
  ];
  if (MCP_ENABLED && mcp) {
    commandDisposables.push(
      ...registerMcpCommands({
        context,
        hostEnv: mcp.hostEnv,
        currentWorkspaceFolder: mcp.currentWorkspaceFolder
      })
    );
  }

  context.subscriptions.push(
    ...(mcp ? [mcp.bridgeServer, mcp.sftpAgentService, mcp.agentAuditLog] : []),
    ...commandDisposables,
    serversTreeView,
    sftpTreeView,
    sftpEditStatus,
    sftpEditManager,
    portForwardStatus,
    cleanup,
    vscode.workspace.registerTextDocumentContentProvider(SFTP_PREVIEW_SCHEME, sftpPreviewStore),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SFTP_PREVIEW_SCHEME) {
        void sftpPreviewStore.deletePreviewFile(document.uri);
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void sftpPreviewStore.deletePreviewFilesForClosedTabs(event.closed);
    })
  );

  // Repaint the servers view out of viewsWelcome and expand a lone group.
  treeProvider.refresh();
  void configManager
    .listServers()
    .then(async (servers) => {
      treeProvider.refresh();
      if (servers.length === 0) {
        return;
      }
      const roots = await treeProvider.getChildren();
      const firstGroup = roots[0];
      if (roots.length === 1 && firstGroup instanceof GroupTreeItem) {
        await serversTreeView.reveal(firstGroup, { expand: true, focus: false, select: false });
      }
    })
    .catch((error) => {
      console.error('AT Terminal: initial servers tree reveal failed:', formatError(error));
    });
}

export function deactivate(): void {
  extensionCleanup?.dispose();
  TerminalPanel.disconnectAll();
}

// Public helpers re-exported for existing tests and downstream callers.
export {
  adoptRegistryTerminalIfSftpInactive,
  createRegistryBackedSftpTreeSource,
  refreshSftpFilesView,
  registerSftpContextWiring,
  type RefreshSftpFilesViewOptions,
  type SftpContextWiringOptions,
  type SftpTerminalRegistrySource
} from './extension/wiring';
export {
  deleteServerAndTrust,
  formatJumpHostDeleteBlockMessage,
  promptChangedHostKey,
  serverConnectionStates,
  type ServerConnectionState
} from './extension/serverHelpers';
