import * as vscode from 'vscode';
import { formatFileSize } from '../sftp/FileSize';
import type { SftpEntry } from '../sftp/SftpTypes';

export class SftpPlaceholderTreeItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sftpPlaceholder';
  }
}

export class SftpParentDirectoryTreeItem extends vscode.TreeItem {
  constructor() {
    super('..', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'sftpParentDirectory';
    this.command = {
      command: 'sshManager.sftp.goUp',
      title: 'Go Up'
    };
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
    this.description = entry.size === undefined ? undefined : formatFileSize(entry.size);
    this.tooltip = entry.path;
  }
}
