import * as vscode from 'vscode';
import { AgentToolService } from './agent/AgentToolService';
import { RemoteCommandExecutor } from './agent/RemoteCommandExecutor';
import { SftpAgentService } from './agent/SftpAgentService';
import { createProductionSftpWriteAuthorizer } from './agent/createSftpWriteAuthorizer';
import { assetPrivateKeyDirectory, exportAssetsCommand, importAssetsCommand } from './assets/AssetCommands';
import { MCP_ENABLED } from './buildFlags';
import { ConfigManager } from './config/ConfigManager';
import type { ServerConfig } from './config/schema';
import { BridgeServer } from './mcp/BridgeServer';
import { detectHostApp } from './mcp/hostApp';
import { syncPackagedHub } from './mcp/hubSync';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from './mcp/McpConfigInstaller';
import { dirname, joinRemotePath, quotePosixShellPath, safePreviewName } from './sftp/RemotePath';
import { SftpDragAndDropController, localUploadFileName } from './sftp/SftpDragAndDropController';
import { createVscodeSftpEditUi, resolveEditStorageUri, SftpEditSessionManager } from './sftp/SftpEditSessionManager';
import { SftpManager } from './sftp/SftpManager';
import { createRemoteFileForEditing } from './sftp/SftpNewFile';
import { SFTP_PREVIEW_SCHEME, SftpPreviewDocumentStore, openRemotePreviewFile } from './sftp/SftpPreview';
import { SftpSession } from './sftp/SftpSession';
import { VscodeTransferReporter } from './sftp/VscodeTransferReporter';
import { HostKeyStore } from './ssh/HostKeyStore';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { ServerTreeProvider } from './tree/ServerTreeProvider';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from './tree/SftpTreeItems';
import { GroupTreeItem, ServerTreeItem } from './tree/TreeItems';
import { formatError } from './utils/errors';
import { showTimedNotification } from './utils/notifications';
import { ServerFormPanel } from './webview/ServerFormPanel';
import { TerminalPanel } from './webview/TerminalPanel';

let extensionCleanup: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigManager(context.globalState, context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const treeProvider = new ServerTreeProvider(configManager);
  const terminalContext = new TerminalContextRegistry();
  const hostKeyVerifier = {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await hostKeyStore.check(host, port, fingerprint);
      if (status === 'trusted') {
        return true;
      }
      if (status === 'changed') {
        await showTimedNotification(
          `Host key for ${host}:${port} changed. Connection blocked. Fingerprint: ${fingerprint}`,
          'error'
        );
        return false;
      }
      const answer = await vscode.window.showWarningMessage(
        `Trust SSH host ${host}:${port}? Fingerprint: ${fingerprint}`,
        { modal: true },
        'Trust and Connect'
      );
      if (answer === 'Trust and Connect') {
        await hostKeyStore.trust(host, port, fingerprint);
        return true;
      }
      return false;
    }
  };
  const sftpManager = new SftpManager({
    createSession: (terminal) => new SftpSession(terminal.server, configManager, hostKeyVerifier),
    reporter: new VscodeTransferReporter()
  });
  const sftpTreeProvider = new SftpTreeProvider({
    getState: () => sftpManager.getState(),
    listDirectory: (path) => sftpManager.listDirectory(path)
  });
  const sftpPreviewStore = new SftpPreviewDocumentStore();
  const sftpEditStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  const sftpEditManager = new SftpEditSessionManager({
    storageUri: resolveEditStorageUri(context.globalStorageUri, vscode.workspace.workspaceFolders),
    sftp: sftpManager,
    ui: createVscodeSftpEditUi(sftpEditStatus)
  });
  let disposed = false;
  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      TerminalPanel.disconnectAll();
      sftpManager.dispose();
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
    }
  };
  extensionCleanup = cleanup;

  terminalContext.onDidChangeActiveContext((activeContext) => {
    sftpManager.setTerminalContext(activeContext);
    sftpTreeProvider.refresh();
  });
  terminalContext.onDidChangeContext((changedContext) => {
    if (terminalContext.getActive()?.terminalId !== changedContext.terminalId) {
      sftpManager.syncTerminalContext(changedContext);
    }
  });
  terminalContext.onDidRemoveContext((terminalId) => {
    sftpManager.removeTerminalContext(terminalId);
  });

  const remoteCommandExecutor = new RemoteCommandExecutor(configManager, hostKeyVerifier);
  let bridgeServer: BridgeServer | undefined;
  let sftpAgentService: SftpAgentService | undefined;
  let installMcpConfigCommand: vscode.Disposable | undefined;
  let uninstallMcpConfigCommand: vscode.Disposable | undefined;
  if (MCP_ENABLED) {
    // MCP activate order: detectHostApp → syncPackagedHub → AgentToolService →
    // BridgeServer.start (publish) → ensureAtSeriesConfig → install/uninstall commands.
    // Dispose (via BridgeServer in subscriptions) only unpublishes; never uninstalls MCP
    // config or deletes hub.js.
    const hostEnv = {
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: context.extensionUri.fsPath
    };
    const hostApp = detectHostApp(hostEnv);
    const currentWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
        void showTimedNotification(
          `AT Series hub sync failed: ${formatError(error)}. MCP may not start until Repair succeeds.`,
          'warning'
        );
        throw error;
      });
    const sftpWriteAuthorizer = createProductionSftpWriteAuthorizer();
    sftpAgentService = new SftpAgentService({
      terminalContext,
      createSession: (terminal) => new SftpSession(terminal.server, configManager, hostKeyVerifier),
      authorizer: sftpWriteAuthorizer
    });
    const agentToolService = new AgentToolService({
      configManager,
      terminalContext,
      executor: remoteCommandExecutor,
      sftp: sftpAgentService
    });
    bridgeServer = new BridgeServer({
      service: agentToolService,
      hostApp,
      pluginVersion:
        typeof context.extension?.packageJSON?.version === 'string'
          ? context.extension.packageJSON.version
          : undefined
    });
    void bridgeServer.start().catch((error) => {
      void showTimedNotification(`AT Terminal MCP bridge failed to start: ${formatError(error)}`, 'warning');
    });
    void hubReady
      .then(() =>
        ensureAtSeriesConfigForCurrentIde({
          ...hostEnv,
          workspaceFolder: currentWorkspaceFolder()
        })
      )
      .catch((error) => {
        void showTimedNotification(`AT Series MCP config could not be updated: ${formatError(error)}`, 'warning');
      });
    installMcpConfigCommand = vscode.commands.registerCommand('sshManager.installMcpConfig', async () => {
      try {
        await syncPackagedHub(context);
      } catch (error) {
        await showTimedNotification(`AT Series hub sync failed: ${formatError(error)}`, 'error');
        return;
      }
      const result = await ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result) {
        await showTimedNotification(
          result.updated ? 'AT Series MCP config installed/repaired.' : 'AT Series MCP config is already up to date.'
        );
        return;
      }
      await showTimedNotification(
        'No supported IDE MCP config target was detected. Open a workspace to install Continue config.',
        'warning'
      );
    });
    uninstallMcpConfigCommand = vscode.commands.registerCommand('sshManager.uninstallAtSeriesMcpConfig', async () => {
      const result = await uninstallAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result?.removed) {
        await showTimedNotification('AT Series MCP config uninstalled.');
        return;
      }
      if (result) {
        await showTimedNotification('AT Series MCP config was not present.');
        return;
      }
      await showTimedNotification(
        'No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.',
        'warning'
      );
    });
  }

  context.subscriptions.push(
    ...(bridgeServer ? [bridgeServer] : []),
    ...(sftpAgentService ? [sftpAgentService] : []),
    ...(installMcpConfigCommand ? [installMcpConfigCommand] : []),
    ...(uninstallMcpConfigCommand ? [uninstallMcpConfigCommand] : []),
    vscode.window.createTreeView('sshManager.servers', {
      treeDataProvider: treeProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView('sshManager.sftpFiles', {
      treeDataProvider: sftpTreeProvider,
      dragAndDropController: new SftpDragAndDropController(sftpManager),
      showCollapseAll: true
    }),
    sftpEditStatus,
    sftpEditManager,
    cleanup,
    vscode.workspace.registerTextDocumentContentProvider(SFTP_PREVIEW_SCHEME, sftpPreviewStore),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SFTP_PREVIEW_SCHEME) {
        void sftpPreviewStore.deletePreviewFile(document.uri);
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      void sftpPreviewStore.deletePreviewFilesForClosedTabs(event.closed);
    }),
    vscode.commands.registerCommand('sshManager.exportAssets', async () => {
      await exportAssetsCommand({
        configManager,
        extensionName: context.extension.packageJSON.name,
        extensionVersion: context.extension.packageJSON.version
      });
    }),
    vscode.commands.registerCommand('sshManager.importAssets', async () => {
      await importAssetsCommand({
        configManager,
        privateKeyDirectory: assetPrivateKeyDirectory(context),
        refreshServers: () => treeProvider.refresh()
      });
    }),
    vscode.commands.registerCommand('sshManager.addServer', (item?: GroupTreeItem) => {
      const initialGroup = item instanceof GroupTreeItem ? item.groupName : undefined;
      void ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), undefined, hostKeyVerifier, initialGroup);
    }),
    vscode.commands.registerCommand('sshManager.editServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const server = await configManager.getServer(item.server.id);
      if (server) {
        await ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), server, hostKeyVerifier);
      }
    }),
    vscode.commands.registerCommand('sshManager.deleteServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const references = await configManager.findJumpHostReferences(item.server.id);
      if (references.length > 0) {
        await showTimedNotification(formatJumpHostDeleteBlockMessage(item.server, references), 'warning');
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete SSH server "${item.server.label}"?`,
        { modal: true },
        'Delete'
      );
      if (answer === 'Delete') {
        await deleteServerAndTrust.remove(item.server, { configManager, hostKeyStore });
        treeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('sshManager.connect', (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      TerminalPanel.open(context, item.server, configManager, hostKeyVerifier, terminalContext);
    }),
    vscode.commands.registerCommand('sshManager.copyHost', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(`${item.server.username}@${item.server.host}:${item.server.port}`);
    }),
    vscode.commands.registerCommand('sshManager.refresh', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('sshManager.disconnect', () => {
      TerminalPanel.getActive()?.disconnect();
    }),
    vscode.commands.registerCommand('sshManager.reconnect', async () => {
      await TerminalPanel.getActive()?.reconnect();
    }),
    vscode.commands.registerCommand('sshManager.sftp.refresh', () => {
      sftpTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('sshManager.sftp.goToPath', async () => {
      await runSftpCommand(async () => {
        const state = sftpManager.getState();
        const currentPath = state.kind === 'active' ? state.rootPath : '';
        const nextPath = await vscode.window.showInputBox({
          prompt: 'Remote path',
          value: currentPath
        });
        if (!nextPath?.trim()) {
          return;
        }
        await sftpManager.changeDirectory(nextPath.trim());
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.goUp', async () => {
      await runSftpCommand(async () => {
        await sftpManager.changeToParentDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        const files = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: true });
        if (!files?.length) {
          return;
        }
        const state = sftpManager.getState();
        const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
        for (const file of files) {
          await sftpManager.uploadFile(file.fsPath, joinRemotePath(targetDirectory, localUploadFileName(file.fsPath)));
        }
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.download', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(item.entry.name) });
        if (!destination) {
          return;
        }
        await sftpManager.downloadFile(item.entry.path, destination.fsPath);
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        const answer = await vscode.window.showWarningMessage(
          `Delete remote ${item.entry.type} "${item.entry.path}"?`,
          { modal: true },
          'Delete'
        );
        if (answer === 'Delete') {
          await sftpManager.deleteEntry(item.entry);
          sftpTreeProvider.refresh();
        }
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.rename', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        const nextName = await vscode.window.showInputBox({ prompt: 'New remote name', value: item.entry.name });
        if (!nextName || nextName === item.entry.name) {
          return;
        }
        await sftpManager.rename(item.entry.path, joinRemotePath(dirname(item.entry.path), nextName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.newFile', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        const state = sftpManager.getState();
        await createRemoteFileForEditing({
          entry: item?.entry,
          rootPath: state.kind === 'active' ? state.rootPath : '.',
          promptName: async () => vscode.window.showInputBox({ prompt: 'New remote file name' }),
          createFile: (remotePath) => sftpManager.createFile(remotePath),
          openRemoteFile: async (remotePath) => {
            await sftpEditManager.openRemoteFile(remotePath);
          },
          refresh: () => sftpTreeProvider.refresh()
        });
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.newFolder', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        const folderName = await vscode.window.showInputBox({ prompt: 'New remote folder name' });
        if (!folderName) {
          return;
        }
        const state = sftpManager.getState();
        const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
        await sftpManager.mkdir(joinRemotePath(targetDirectory, folderName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.copyPath', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (item) {
        await vscode.env.clipboard.writeText(item.entry.path);
      }
    }),
    vscode.commands.registerCommand('sshManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        await sftpEditManager.openRemoteFile(item.entry.path);
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.openPreview', async (item?: SftpFileTreeItem) => {
      await runSftpCommand(async () => {
        if (!item) {
          return;
        }
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath),
          openUri: async (uri, openOptions) => {
            await vscode.commands.executeCommand('vscode.open', uri, openOptions);
          }
        });
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.cdToDirectory', (item?: SftpDirectoryTreeItem) => {
      if (item) {
        terminalContext.getActive()?.write(`cd ${quotePosixShellPath(item.entry.path)}\r`);
      }
    })
  );
}

export function deactivate(): void {
  extensionCleanup?.dispose();
  TerminalPanel.disconnectAll();
}

async function runSftpCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    await showTimedNotification(formatError(error), 'error');
  }
}

function getTargetDirectory(
  item: SftpDirectoryTreeItem | SftpFileTreeItem | undefined,
  rootPath: string
): string {
  if (!item) {
    return rootPath;
  }
  return item instanceof SftpFileTreeItem ? dirname(item.entry.path) : item.entry.path;
}

export function formatJumpHostDeleteBlockMessage(server: ServerConfig, references: ServerConfig[]): string {
  return `Cannot delete "${server.label}" because it is used as a jump host by: ${references
    .map((reference) => reference.label)
    .join(', ')}`;
}

export const deleteServerAndTrust = {
  formatBlockMessage: formatJumpHostDeleteBlockMessage,
  async remove(
    server: ServerConfig,
    dependencies: {
      configManager: Pick<ConfigManager, 'deleteServer'>;
      hostKeyStore: Pick<HostKeyStore, 'forget'>;
    }
  ): Promise<void> {
    await dependencies.configManager.deleteServer(server.id);
    await dependencies.hostKeyStore.forget(server.host, server.port);
  }
};
