import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { SftpManager } from './sftp/SftpManager';
import { SftpSession } from './sftp/SftpSession';
import { HostKeyStore } from './ssh/HostKeyStore';
import { TerminalContextRegistry } from './terminal/TerminalContext';
import { ServerTreeProvider } from './tree/ServerTreeProvider';
import { SftpTreeProvider } from './tree/SftpTreeProvider';
import { ServerTreeItem } from './tree/TreeItems';
import { ServerFormPanel } from './webview/ServerFormPanel';
import { TerminalPanel } from './webview/TerminalPanel';

export function activate(context: vscode.ExtensionContext): void {
  const configManager = new ConfigManager(context.globalState, context.secrets);
  const hostKeyStore = new HostKeyStore(context.globalState);
  const treeProvider = new ServerTreeProvider(configManager);
  const terminalContext = new TerminalContextRegistry();
  const sftpManager = new SftpManager({
    createSession: (terminal) => new SftpSession(terminal.server, configManager)
  });
  const sftpTreeProvider = new SftpTreeProvider({
    getState: () => sftpManager.getState(),
    listDirectory: (path) => sftpManager.listDirectory(path)
  });

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
      showCollapseAll: true
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
    vscode.commands.registerCommand('sshManager.sftp.upload', () => showSftpUnavailable('Upload')),
    vscode.commands.registerCommand('sshManager.sftp.download', () => showSftpUnavailable('Download')),
    vscode.commands.registerCommand('sshManager.sftp.delete', () => showSftpUnavailable('Delete')),
    vscode.commands.registerCommand('sshManager.sftp.rename', () => showSftpUnavailable('Rename')),
    vscode.commands.registerCommand('sshManager.sftp.newFolder', () => showSftpUnavailable('New folder')),
    vscode.commands.registerCommand('sshManager.sftp.copyPath', () => showSftpUnavailable('Copy path')),
    vscode.commands.registerCommand('sshManager.sftp.openPreview', () => showSftpUnavailable('Open preview')),
    vscode.commands.registerCommand('sshManager.sftp.cdToDirectory', () => showSftpUnavailable('cd to directory'))
  );
}

export function deactivate(): void {}

function showSftpUnavailable(commandName: string): Thenable<string | undefined> {
  return vscode.window.showInformationMessage(`${commandName} requires the SFTP operations task to be completed.`);
}
