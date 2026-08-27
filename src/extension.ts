import * as vscode from 'vscode';
import { AgentToolService } from './agent/AgentToolService';
import { RemoteCommandExecutor } from './agent/RemoteCommandExecutor';
import { SftpAgentService } from './agent/SftpAgentService';
import { createProductionSftpWriteAuthorizer } from './agent/createSftpWriteAuthorizer';
import { assetPrivateKeyDirectory, exportAssetsCommand, importAssetsCommand } from './assets/AssetCommands';
import { ConfigManager } from './config/ConfigManager';
import type { ServerConfig } from './config/schema';
import { BridgeServer } from './mcp/BridgeServer';
import { syncPackagedHub } from './mcp/hubSync';
import {
  ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde
} from './mcp/McpConfigInstaller';
import { detectHostApp } from '@at-series/mcp-hub';
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
import { showErrorWithActions, showTimedNotification } from './utils/notifications';
import { ServerFormPanel } from './webview/ServerFormPanel';
import { TerminalPanel } from './webview/TerminalPanel';
import { t } from './i18n/t';

let extensionCleanup: { dispose(): void } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigManager(context.globalState, context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const terminalContext = new TerminalContextRegistry();
  const treeProvider = new ServerTreeProvider(configManager, () =>
    serverConnectionStates(terminalContext.getSnapshot().knownTerminals)
  );
  const hostKeyVerifier = {
    async verify(host: string, port: number, fingerprint: string): Promise<boolean> {
      const status = await hostKeyStore.check(host, port, fingerprint);
      if (status === 'trusted') {
        return true;
      }
      if (status === 'changed') {
        return promptChangedHostKey(host, port, fingerprint, hostKeyStore);
      }
      const trustAction = t('Trust and Connect');
      const answer = await vscode.window.showWarningMessage(
        t('Trust SSH host {host}:{port}? Fingerprint: {fingerprint}', { host, port, fingerprint }),
        { modal: true },
        trustAction
      );
      if (answer === trustAction) {
        await hostKeyStore.trust(host, port, fingerprint);
        return true;
      }
      return false;
    }
  };
  const sftpManager = new SftpManager({
    // The SFTP view is driven by the user, so a denied write may retry under sudo.
    createSession: (terminal) =>
      new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: true }),
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
  const remoteCommandExecutor = new RemoteCommandExecutor(configManager, hostKeyVerifier);
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
    // Connection state feeds the Servers tree icon/description.
    treeProvider.refresh();
  });
  terminalContext.onDidRemoveContext((terminalId) => {
    sftpManager.removeTerminalContext(terminalId);
    treeProvider.refresh();
  });

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
    sftpAgentService = new SftpAgentService({
      terminalContext,
      // Agent writes never escalate: a denied write stays denied instead of silently
      // becoming a root write through the sudo fallback.
      createSession: (terminal) =>
        new SftpSession(terminal.server, configManager, hostKeyVerifier, { allowSudoFallback: false }),
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
    installMcpConfigCommand = vscode.commands.registerCommand('sshManager.installMcpConfig', async () => {
      try {
        await syncPackagedHub(context);
      } catch (error) {
        const repairAction = t('Repair');
        void showErrorWithActions(
          t('AT Series hub sync failed: {message}', { message: formatError(error) }),
          repairAction
        ).then((choice) => {
          if (choice === repairAction) {
            void vscode.commands.executeCommand('sshManager.installMcpConfig');
          }
        });
        return;
      }
      const result = await ensureAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result) {
        showTimedNotification(
          result.updated
            ? t('AT Series MCP config installed/repaired.')
            : t('AT Series MCP config is already up to date.')
        );
        return;
      }
      void vscode.window.showWarningMessage(
        t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.')
      );
    });
    uninstallMcpConfigCommand = vscode.commands.registerCommand('sshManager.uninstallAtSeriesMcpConfig', async () => {
      const result = await uninstallAtSeriesConfigForCurrentIde({
        ...hostEnv,
        workspaceFolder: currentWorkspaceFolder()
      });
      if (result?.removed) {
        showTimedNotification(t('AT Series MCP config uninstalled.'));
        return;
      }
      if (result) {
        showTimedNotification(t('AT Series MCP config was not present.'));
        return;
      }
      void vscode.window.showWarningMessage(
        t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.')
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
      void ServerFormPanel.open(
        context,
        configManager,
        (savedServer) => {
          if (savedServer) {
            terminalContext.updateServer(savedServer);
            TerminalPanel.updateServer(savedServer);
          }
          treeProvider.refresh();
        },
        undefined,
        hostKeyVerifier,
        initialGroup
      );
    }),
    vscode.commands.registerCommand('sshManager.editServer', async (item?: ServerTreeItem) => {
      const picked = item?.server ?? (await pickServer(configManager));
      if (!picked) {
        return;
      }
      const server = await configManager.getServer(picked.id);
      if (server) {
        await ServerFormPanel.open(
          context,
          configManager,
          (savedServer) => {
            if (savedServer) {
              terminalContext.updateServer(savedServer);
              TerminalPanel.updateServer(savedServer);
            }
            treeProvider.refresh();
          },
          server,
          hostKeyVerifier
        );
      }
    }),
    vscode.commands.registerCommand('sshManager.deleteServer', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      const references = await configManager.findJumpHostReferences(server.id);
      if (references.length > 0) {
        void vscode.window.showWarningMessage(formatJumpHostDeleteBlockMessage(server, references));
        return;
      }
      const deleteAction = t('Delete');
      const answer = await vscode.window.showWarningMessage(
        t('Delete SSH server "{label}"?', { label: server.label }),
        { modal: true },
        deleteAction
      );
      if (answer === deleteAction) {
        await deleteServerAndTrust.remove(server, { configManager, hostKeyStore });
        treeProvider.refresh();
      }
    }),
    vscode.commands.registerCommand('sshManager.connect', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      TerminalPanel.open(context, server, configManager, hostKeyVerifier, terminalContext);
    }),
    vscode.commands.registerCommand('sshManager.copyHost', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      await vscode.env.clipboard.writeText(`${server.username}@${server.host}:${server.port}`);
    }),
    vscode.commands.registerCommand('sshManager.viewHostFingerprint', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      const trusted = hostKeyStore.getTrusted(server.host, server.port);
      if (!trusted) {
        void vscode.window.showInformationMessage(
          t('No trusted host key is stored for {host}:{port}. The next connection will ask to trust the fingerprint.', {
            host: server.host,
            port: server.port
          })
        );
        return;
      }
      const copyAction = t('Copy Fingerprint');
      const choice = await vscode.window.showInformationMessage(
        t('Stored fingerprint for {host}:{port}: {fingerprint}', {
          host: server.host,
          port: server.port,
          fingerprint: trusted.fingerprint
        }),
        copyAction
      );
      if (choice === copyAction) {
        await vscode.env.clipboard.writeText(trusted.fingerprint);
      }
    }),
    vscode.commands.registerCommand('sshManager.forgetHostKey', async (item?: ServerTreeItem) => {
      const server = item?.server ?? (await pickServer(configManager));
      if (!server) {
        return;
      }
      if (!hostKeyStore.getTrusted(server.host, server.port)) {
        void vscode.window.showInformationMessage(
          t('No trusted host key is stored for {host}:{port}. The next connection will ask to trust the fingerprint.', {
            host: server.host,
            port: server.port
          })
        );
        return;
      }
      await hostKeyStore.forget(server.host, server.port);
      showTimedNotification(
        t('Forgot the host key for {host}:{port}. The next connection will ask to trust the fingerprint again.', {
          host: server.host,
          port: server.port
        })
      );
    }),
    vscode.commands.registerCommand('sshManager.refresh', () => {
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('sshManager.disconnect', () => {
      const active = TerminalPanel.getActive();
      if (!active) {
        void vscode.window.showInformationMessage(t('No active SSH terminal'));
        return;
      }
      active.disconnect();
    }),
    vscode.commands.registerCommand('sshManager.reconnect', async () => {
      const active = TerminalPanel.getActive();
      if (!active) {
        void vscode.window.showInformationMessage(t('No active SSH terminal'));
        return;
      }
      await active.reconnect();
    }),
    vscode.commands.registerCommand('sshManager.sftp.refresh', () => {
      sftpTreeProvider.refresh();
    }),
    vscode.commands.registerCommand('sshManager.sftp.goToPath', async () => {
      await runSftpCommand(async () => {
        const state = sftpManager.getState();
        const currentPath = state.kind === 'active' ? state.rootPath : '';
        const nextPath = await vscode.window.showInputBox({
          prompt: t('Remote path'),
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
        const deleteAction = t('Delete');
        const answer = await vscode.window.showWarningMessage(
          t('Delete remote {type} "{path}"?', { type: item.entry.type, path: item.entry.path }),
          { modal: true },
          deleteAction
        );
        if (answer === deleteAction) {
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
        const nextName = await vscode.window.showInputBox({
          prompt: t('New remote name'),
          value: item.entry.name
        });
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
          promptName: async () => vscode.window.showInputBox({ prompt: t('New remote file name') }),
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
        const folderName = await vscode.window.showInputBox({ prompt: t('New remote folder name') });
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
    // Errors stay on screen until dismissed; only success toasts self-dismiss.
    void vscode.window.showErrorMessage(formatError(error));
  }
}

/**
 * A changed host key blocks the connection by default. Instead of a dead end, the
 * persistent error offers explicit ways out: inspect the stored fingerprint, trust the
 * new key, or forget the stored key so the next connection goes through the normal
 * first-use trust prompt. Nothing is ever trusted automatically.
 */
export async function promptChangedHostKey(
  host: string,
  port: number,
  fingerprint: string,
  hostKeyStore: Pick<HostKeyStore, 'trust' | 'forget' | 'getTrusted'>
): Promise<boolean> {
  const viewAction = t('View Fingerprint');
  const trustAction = t('Trust New Key');
  const forgetAction = t('Forget and Reconnect');
  for (;;) {
    const choice = await vscode.window.showErrorMessage(
      t('Host key for {host}:{port} changed. The connection stays blocked until you trust the new key or forget the stored one. New fingerprint: {fingerprint}', {
        host,
        port,
        fingerprint
      }),
      viewAction,
      trustAction,
      forgetAction
    );
    if (choice === viewAction) {
      const trusted = hostKeyStore.getTrusted(host, port);
      await vscode.window.showInformationMessage(
        trusted
          ? t('Stored fingerprint for {host}:{port}: {fingerprint}', {
              host,
              port,
              fingerprint: trusted.fingerprint
            })
          : t('No trusted host key is stored for {host}:{port}. The next connection will ask to trust the fingerprint.', {
              host,
              port
            })
      );
      continue;
    }
    if (choice === trustAction) {
      await hostKeyStore.trust(host, port, fingerprint);
      return true;
    }
    if (choice === forgetAction) {
      await hostKeyStore.forget(host, port);
      showTimedNotification(
        t('Forgot the host key for {host}:{port}. The next connection will ask to trust the fingerprint again.', {
          host,
          port
        })
      );
      return false;
    }
    return false;
  }
}

async function pickServer(
  configManager: Pick<ConfigManager, 'listServers'>
): Promise<ServerConfig | undefined> {
  const servers = await configManager.listServers();
  if (servers.length === 0) {
    void vscode.window.showInformationMessage(
      t('No SSH servers configured yet. Run "SSH: Add Server" to create one.')
    );
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    servers.map((server) => ({
      label: server.label,
      description: `${server.username}@${server.host}:${server.port}`,
      server
    })),
    { placeHolder: t('Select an SSH server') }
  );
  return picked?.server;
}

export type ServerConnectionState = 'connected' | 'disconnected';

/**
 * Reduces terminal summaries to one state per server: any connected terminal wins;
 * known-but-disconnected terminals mark the server as disconnected; servers without a
 * terminal stay absent so the tree keeps their neutral icon.
 */
export function serverConnectionStates(
  terminals: ReadonlyArray<{ serverId: string; connected: boolean }>
): Map<string, ServerConnectionState> {
  const states = new Map<string, ServerConnectionState>();
  for (const terminal of terminals) {
    if (terminal.connected) {
      states.set(terminal.serverId, 'connected');
    } else if (!states.has(terminal.serverId)) {
      states.set(terminal.serverId, 'disconnected');
    }
  }
  return states;
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
  return t('Cannot delete "{label}" because it is used as a jump host by: {references}', {
    label: server.label,
    references: references.map((reference) => reference.label).join(', ')
  });
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

