import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';

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
      `Group: ${server.group?.trim() || 'Default'}`,
      `Host: ${server.host}`,
      `Port: ${server.port}`,
      `Username: ${server.username}`,
      `Authentication: ${server.authType === 'privateKey' ? 'Private Key' : 'Password'}`,
      `Keepalive: ${server.keepAliveInterval}s`
    ].join('\n');
    this.command = {
      command: 'sshManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}
