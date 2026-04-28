import * as vscode from 'vscode';
import type { SftpEntry } from '../sftp/SftpTypes';

export class SftpPlaceholderTreeItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sftpPlaceholder';
  }
}

export class SftpDirectoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: SftpEntry,
    disconnected = false
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = disconnected ? 'sftpDisconnectedDirectory' : 'sftpDirectory';
    this.tooltip = entry.path;
  }
}

export class SftpFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: SftpEntry,
    disconnected = false
  ) {
    super(entry.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = disconnected ? 'sftpDisconnectedFile' : 'sftpFile';
    this.description = entry.size === undefined ? undefined : `${entry.size} B`;
    this.tooltip = entry.path;
  }
}
