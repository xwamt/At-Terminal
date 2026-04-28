import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { GroupTreeItem, ServerTreeItem } from './TreeItems';

export interface ServerListSource {
  listServers(): Promise<ServerConfig[]>;
}

export class ServerTreeProvider implements vscode.TreeDataProvider<GroupTreeItem | ServerTreeItem> {
  private readonly changed = new vscode.EventEmitter<GroupTreeItem | ServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly source: ServerListSource) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: GroupTreeItem | ServerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GroupTreeItem | ServerTreeItem): Promise<Array<GroupTreeItem | ServerTreeItem>> {
    const servers = await this.source.listServers();
    if (!element) {
      return Array.from(new Set(servers.map((server) => this.groupName(server))))
        .sort((a, b) => a.localeCompare(b))
        .map((group) => new GroupTreeItem(group));
    }
    if (element instanceof GroupTreeItem) {
      return servers
        .filter((server) => this.groupName(server) === element.groupName)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((server) => new ServerTreeItem(server));
    }
    return [];
  }

  private groupName(server: ServerConfig): string {
    const group = server.group?.trim();
    return group && group.length > 0 ? group : 'Default';
  }
}
