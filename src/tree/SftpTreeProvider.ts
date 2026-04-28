import * as vscode from 'vscode';
import type { SftpEntry } from '../sftp/SftpTypes';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from './SftpTreeItems';

export type SftpTreeState =
  | { kind: 'none' }
  | { kind: 'active'; rootPath: string }
  | { kind: 'disconnected'; rootPath: string; entries: SftpEntry[] };

export interface SftpTreeSource {
  getState(): SftpTreeState;
  listDirectory?(path: string): Promise<SftpEntry[]>;
}

export type SftpTreeNode = SftpPlaceholderTreeItem | SftpDirectoryTreeItem | SftpFileTreeItem;

export class SftpTreeProvider implements vscode.TreeDataProvider<SftpTreeNode> {
  private readonly changed = new vscode.EventEmitter<SftpTreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: SftpTreeSource) {}

  refresh(item?: SftpTreeNode): void {
    this.changed.fire(item);
  }

  getTreeItem(element: SftpTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SftpTreeNode): Promise<SftpTreeNode[]> {
    const state = this.source.getState();
    if (state.kind === 'none') {
      return element ? [] : [new SftpPlaceholderTreeItem('No active SSH terminal')];
    }
    if (state.kind === 'disconnected') {
      return element ? [] : state.entries.map((entry) => this.toTreeItem(entry, true));
    }
    const path = element instanceof SftpDirectoryTreeItem ? element.entry.path : state.rootPath;
    const entries = await this.source.listDirectory?.(path);
    return (entries ?? []).map((entry) => this.toTreeItem(entry, false));
  }

  private toTreeItem(entry: SftpEntry, disconnected: boolean): SftpTreeNode {
    return entry.type === 'directory'
      ? new SftpDirectoryTreeItem(entry, disconnected)
      : new SftpFileTreeItem(entry, disconnected);
  }
}
