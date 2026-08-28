import * as vscode from 'vscode';
import type { ServerConfig } from '../config/schema';
import { GroupTreeItem, ServerTreeItem, type ServerConnectionState } from './TreeItems';
import { t } from '../i18n/t';

export interface ServerListSource {
  listServers(): Promise<ServerConfig[]>;
}

export class ServerTreeProvider implements vscode.TreeDataProvider<GroupTreeItem | ServerTreeItem> {
  private readonly changed = new vscode.EventEmitter<GroupTreeItem | ServerTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly source: ServerListSource,
    private readonly connectionStates?: () => ReadonlyMap<string, ServerConnectionState>
  ) {}

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(element: GroupTreeItem | ServerTreeItem): vscode.TreeItem {
    return element;
  }

  /** Required by TreeView.reveal: groups are roots, servers sit under their group. */
  getParent(element: GroupTreeItem | ServerTreeItem): GroupTreeItem | undefined {
    if (element instanceof ServerTreeItem) {
      return new GroupTreeItem(this.groupName(element.server));
    }
    return undefined;
  }

  async getChildren(element?: GroupTreeItem | ServerTreeItem): Promise<Array<GroupTreeItem | ServerTreeItem>> {
    try {
      return await this.loadChildren(element);
    } catch (error) {
      // A throwing getChildren leaves the whole view stuck on an error; an empty
      // result keeps the tree alive so a later refresh can show the real servers.
      console.error('AT Terminal: failed to load the servers tree:', error);
      return [];
    }
  }

  private async loadChildren(
    element?: GroupTreeItem | ServerTreeItem
  ): Promise<Array<GroupTreeItem | ServerTreeItem>> {
    const servers = await this.source.listServers();
    if (!element) {
      const groups = Array.from(new Set(servers.map((server) => this.groupName(server)))).sort((a, b) =>
        a.localeCompare(b)
      );
      // A lone collapsed group (usually "Default") makes the view look empty
      // right after an import; expand it so the servers are visible at once.
      const state =
        groups.length === 1 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
      return groups.map((group) => new GroupTreeItem(group, state));
    }
    if (element instanceof GroupTreeItem) {
      const states = this.connectionStates?.();
      return servers
        .filter((server) => this.groupName(server) === element.groupName)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((server) => new ServerTreeItem(server, states?.get(server.id)));
    }
    return [];
  }

  private groupName(server: ServerConfig): string {
    const group = server.group?.trim();
    return group && group.length > 0 ? group : t('Default');
  }
}
