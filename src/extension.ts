import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { dirname, joinRemotePath, quotePosixShellPath, safePreviewName } from './sftp/RemotePath';
import { SftpDragAndDropController, localUploadFileName } from './sftp/SftpDragAndDropController';
import { SftpManager } from './sftp/SftpManager';
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
import { ServerFormPanel } from './webview/ServerFormPanel';
import { TerminalPanel } from './webview/TerminalPanel';

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
        await vscode.window.showErrorMessage(
          `Host key for ${host}:${port} changed. Connection blocked. Fingerprint: ${fingerprint}`
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

  context.subscriptions.push(
    vscode.window.createTreeView('sshManager.servers', {
      treeDataProvider: treeProvider,
      showCollapseAll: true
    }),
    vscode.window.createTreeView('sshManager.sftpFiles', {
      treeDataProvider: sftpTreeProvider,
      dragAndDropController: new SftpDragAndDropController(sftpManager),
      showCollapseAll: true
    }),
    vscode.workspace.registerTextDocumentContentProvider(SFTP_PREVIEW_SCHEME, sftpPreviewStore),
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme === SFTP_PREVIEW_SCHEME) {
        void sftpPreviewStore.deletePreviewFile(document.uri);
      }
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
          openUri: async (uri) => {
            await vscode.commands.executeCommand('vscode.open', uri);
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

export function deactivate(): void {}

async function runSftpCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
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
