import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { t } from '../i18n/t';

export type ServerConnectionState = 'connected' | 'disconnected';

export class GroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly groupName: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.Collapsed
  ) {
    super(groupName, collapsibleState);
    this.contextValue = 'group';
  }
}

export class ServerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly server: ServerConfig,
    connectionState?: ServerConnectionState
  ) {
    super(server.label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'server';
    const target = `${server.username}@${server.host}:${server.port}`;
    if (connectionState === 'connected') {
      this.iconPath = new vscode.ThemeIcon('vm-active');
      this.description = `${target} · ${t('Connected')}`;
    } else if (connectionState === 'disconnected') {
      this.iconPath = new vscode.ThemeIcon('debug-disconnect');
      this.description = target;
    } else {
      this.iconPath = new vscode.ThemeIcon('server');
      this.description = target;
    }
    this.tooltip = [
      server.label,
      t('Group: {group}', { group: server.group?.trim() || t('Default') }),
      t('Host: {host}', { host: server.host }),
      t('Port: {port}', { port: server.port }),
      t('Username: {username}', { username: server.username }),
      t('Authentication: {auth}', {
        auth: authLabel(server.authType)
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

function authLabel(authType: ServerConfig['authType']): string {
  if (authType === 'privateKey') {
    return t('Private Key');
  }
  if (authType === 'agent') {
    return t('SSH Agent');
  }
  return t('Password');
}
