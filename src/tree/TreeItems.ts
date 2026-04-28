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
    this.description = `${server.username}@${server.host}:${server.port}`;
    this.tooltip = this.description;
    this.command = {
      command: 'sshManager.connect',
      title: 'Connect',
      arguments: [this]
    };
  }
}
