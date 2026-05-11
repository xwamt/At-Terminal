import * as vscode from 'vscode';
import { AgentToolService } from './agent/AgentToolService';
import { registerAgentTools } from './agent/AgentTools';
import { RemoteCommandExecutor } from './agent/RemoteCommandExecutor';
import { SftpAgentService } from './agent/SftpAgentService';
import { SftpWriteAuthorizer } from './agent/SftpWriteAuthorizer';
import { MCP_ENABLED } from './buildFlags';
import { ConfigManager } from './config/ConfigManager';
import { BridgeServer } from './mcp/BridgeServer';
import { ensureKiroMcpConfig, installContinueMcpConfig, installKiroMcpConfig } from './mcp/McpConfigInstaller';
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
import { ServerTreeItem } from './tree/TreeItems';
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
  const sftpManager = new SftpManager({
    createSession: (terminal) => new SftpSession(terminal.server, configManager),
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
  const remoteCommandExecutor = new RemoteCommandExecutor(configManager, hostKeyVerifier);
  let agentToolDisposables: vscode.Disposable[] = [];
  let bridgeServer: BridgeServer | undefined;
  let sftpAgentService: SftpAgentService | undefined;
  let installMcpConfigCommand: vscode.Disposable | undefined;
  if (MCP_ENABLED) {
    const mcpServerPath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'mcp-server.js').fsPath;
    const sftpWriteAuthorizer = new SftpWriteAuthorizer();
    sftpAgentService = new SftpAgentService({
      terminalContext,
      createSession: (terminal) => new SftpSession(terminal.server, configManager),
      authorizer: sftpWriteAuthorizer
    });
    const agentToolService = new AgentToolService({
      configManager,
      terminalContext,
      executor: remoteCommandExecutor,
      sftp: sftpAgentService
    });
    agentToolDisposables = registerAgentTools(agentToolService);
    bridgeServer = new BridgeServer(agentToolService);
    void bridgeServer.start().catch((error) => {
      void showTimedNotification(`AT Terminal MCP bridge failed to start: ${formatError(error)}`, 'warning');
    });
    void ensureKiroMcpConfig({ mcpServerPath }).catch((error) => {
      void showTimedNotification(`AT Terminal MCP config could not be updated: ${formatError(error)}`, 'warning');
    });
    installMcpConfigCommand = vscode.commands.registerCommand('sshManager.installMcpConfig', async () => {
      const kiroTarget = await installKiroMcpConfig({ mcpServerPath });
      const targets = [kiroTarget];
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceFolder) {
        targets.push(await installContinueMcpConfig({ workspaceFolder, mcpServerPath }));
      }
      await showTimedNotification(`AT Terminal MCP config installed: ${targets.join('; ')}`);
    });
  }

  context.subscriptions.push(
    ...agentToolDisposables,
    ...(bridgeServer ? [bridgeServer] : []),
    ...(sftpAgentService ? [sftpAgentService] : []),
    ...(installMcpConfigCommand ? [installMcpConfigCommand] : []),
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
    vscode.commands.registerCommand('sshManager.addServer', () => {
      ServerFormPanel.open(context, configManager, () => treeProvider.refresh());
    }),
    vscode.commands.registerCommand('sshManager.editServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const server = await configManager.getServer(item.server.id);
      if (server) {
        ServerFormPanel.open(context, configManager, () => treeProvider.refresh(), server);
      }
    }),
    vscode.commands.registerCommand('sshManager.deleteServer', async (item?: ServerTreeItem) => {
      if (!item) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Delete SSH server "${item.server.label}"?`,
        { modal: true },
        'Delete'
      );
      if (answer === 'Delete') {
        await configManager.deleteServer(item.server.id);
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
