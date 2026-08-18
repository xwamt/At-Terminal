import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { t } from '../i18n/t';

export class GroupTreeItem extends vscode.TreeItem {
  constructor(public readonly groupName: string) {
    super(groupName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'group';
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(public readonly server: ServerConfig) {
    super(server.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'server';
    this.iconPath = new vscode.ThemeIcon('server');
    this.description = `${server.username}@${server.host}:${server.port}`;
    this.tooltip = [
      server.label,
      t('Group: {group}', { group: server.group?.trim() || t('Default') }),
      t('Host: {host}', { host: server.host }),
      t('Port: {port}', { port: server.port }),
      t('Username: {username}', { username: server.username }),
      t('Authentication: {auth}', {
        auth: server.authType === 'privateKey' ? t('Private Key') : t('Password')
      }),
      t('Keepalive: {interval}s', { interval: server.keepAliveInterval })
    ].join('\n');
    this.command = {
      command: 'sshManager.connect',
      title: t('Connect'),
      arguments: [this]
    };
  }
}

