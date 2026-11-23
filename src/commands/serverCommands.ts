import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname as localDirname } from 'node:path';
import * as vscode from 'vscode';
import { assetPrivateKeyDirectory, exportAssetsCommand, importAssetsCommand } from '../assets/AssetCommands';
import { defaultSshConfigPath, parseSshConfig, readSshConfigFile } from '../ssh/SshConfigImport';
import { disposeJumpHostConnections } from '../ssh/SshConnectionConfig';
import { showTimedNotification } from '../utils/notifications';
import { TerminalPanel } from '../webview/TerminalPanel';
import { ServerFormPanel } from '../webview/ServerFormPanel';
import { GroupTreeItem, ServerTreeItem } from '../tree/TreeItems';
import { t } from '../i18n/t';
import type { CommandContext } from './commandContext';
import {
  deleteServerAndTrust,
  formatJumpHostDeleteBlockMessage,
  pickServer
} from '../extension/serverHelpers';

export function registerServerCommands(ctx: CommandContext): vscode.Disposable[] {
  const { context, configManager, hostKeyStore, hostKeyVerifier, terminalContext, treeProvider } = ctx;
  return [
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
              ctx.getSftpAgentService()?.disposeServer(savedServer.id);
              ctx.getRemoteCommandExecutor().disposeServer(savedServer.id);
              disposeJumpHostConnections(savedServer.id);
              void ctx.portForwardManager.stopServer(savedServer.id);
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
        ctx.getSftpAgentService()?.disposeServer(server.id);
        ctx.getRemoteCommandExecutor().disposeServer(server.id);
        disposeJumpHostConnections(server.id);
        void ctx.portForwardManager.stopServer(server.id);
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
    vscode.commands.registerCommand('sshManager.importSshConfig', async () => {
      let configPath = defaultSshConfigPath();
      let read = await readSshConfigFile(configPath);
      if (!read.ok) {
        // The default config is often missing or unreadable; let the user point at
        // the real file instead of dead-ending on an error toast.
        const picked = await vscode.window.showOpenDialog({
          title: t('OpenSSH config file was not readable at {path}. Choose a file to import.', { path: configPath }),
          defaultUri: vscode.Uri.file(localDirname(configPath)),
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: {
            [t('OpenSSH config')]: ['', 'config'],
            [t('All files')]: ['*']
          }
        });
        if (!picked || picked.length === 0) {
          return;
        }
        configPath = picked[0].fsPath;
        read = await readSshConfigFile(configPath);
        if (!read.ok) {
          void vscode.window.showErrorMessage(t('Could not read {path}.', { path: configPath }));
          return;
        }
      }
      const { entries, warnings } = parseSshConfig(read.content);
      if (entries.length === 0) {
        void vscode.window.showInformationMessage(t('No concrete Host entries were found in {path}.', { path: configPath }));
        return;
      }
      const existing = await configManager.listServers();
      const existingHosts = new Set(existing.map((server) => `${server.host}:${server.port}:${server.username}`));
      let imported = 0;
      for (const entry of entries) {
        const username = entry.draft.username ?? userInfo().username;
        const key = `${entry.draft.host}:${entry.draft.port}:${username}`;
        if (existingHosts.has(key)) {
          continue;
        }
        const now = Date.now();
        const jump = entry.proxyJump
          ? existing.find(
              (server) =>
                server.host === entry.proxyJump?.host &&
                (entry.proxyJump.port === undefined || server.port === entry.proxyJump.port)
            )
          : undefined;
        await configManager.saveServer({
          id: randomUUID(),
          label: entry.draft.label,
          host: entry.draft.host,
          port: entry.draft.port,
          username,
          authType: entry.draft.authType,
          privateKeyPath: entry.draft.privateKeyPath,
          jumpHostId: jump?.id,
          keepAliveInterval: 30,
          encoding: 'utf-8',
          createdAt: now,
          updatedAt: now
        });
        existingHosts.add(key);
        imported += 1;
      }
      treeProvider.refresh();
      const warningText = warnings.length ? ` ${warnings.join(' ')}` : '';
      void vscode.window.showInformationMessage(
        t('Imported {count} servers from SSH config.{warnings}', { count: imported, warnings: warningText })
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
    })
  ];
}
