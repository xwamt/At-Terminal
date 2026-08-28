import * as vscode from 'vscode';
import type { SftpEntry } from '../sftp/SftpTypes';
import { formatError } from '../utils/errors';
import {
  SftpDirectoryTreeItem,
  SftpFileTreeItem,
  SftpParentDirectoryTreeItem,
  SftpPlaceholderTreeItem
} from './SftpTreeItems';
import { t } from '../i18n/t';

export type SftpTreeState =
  | { kind: 'none' }
  | { kind: 'active'; rootPath: string }
  | { kind: 'disconnected'; rootPath: string; entries: SftpEntry[] };

/** What the SFTP tree is rendering; produced by `SftpManager.getActiveViewDescriptor()`. */
export interface SftpViewDescriptor {
  terminalId: string;
  rootPath: string | undefined;
  connected: boolean;
}

/**
 * Whether an active-terminal change actually needs an SFTP tree refresh. Switching back to
 * the terminal the tree already shows (same terminal, same root, same connection state)
 * would only re-list every visible directory for an identical result, so that case is
 * skipped. `extension.ts` calls this around `SftpManager.setTerminalContext`.
 */
export function shouldRefreshOnContextChange(
  previous: SftpViewDescriptor | undefined,
  next: SftpViewDescriptor | undefined
): boolean {
  if (!previous || !next) {
    // Both missing: the view showed the placeholder before and still does, so a repaint
    // would be a no-op. Gaining or losing the descriptor always repaints.
    return Boolean(previous) !== Boolean(next);
  }
  return (
    previous.terminalId !== next.terminalId ||
    previous.rootPath !== next.rootPath ||
    previous.connected !== next.connected
  );
}

export interface SftpTreeSource {
  getState(): SftpTreeState;
  listDirectory?(path: string): Promise<SftpEntry[]>;
}

export type SftpTreeNode =
  | SftpPlaceholderTreeItem
  | SftpParentDirectoryTreeItem
  | SftpDirectoryTreeItem
  | SftpFileTreeItem;

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
      return element ? [] : [new SftpPlaceholderTreeItem(t('No active SSH terminal'))];
    }

    if (state.kind === 'disconnected') {
      return element ? [] : state.entries.map((entry) => this.toTreeItem(entry, true));
    }
    const path = element instanceof SftpDirectoryTreeItem ? element.entry.path : state.rootPath;
    let entries: SftpEntry[] | undefined;
    try {
      entries = await this.source.listDirectory?.(path);
    } catch (error) {
      // When getChildren rejects, VS Code keeps the previous children — right after a
      // connect that is still the "No active SSH terminal" placeholder, which lies about a
      // live terminal whose SFTP channel failed (its own second SSH connection, e.g. on
      // keyboard-interactive servers). Render the failure instead so refresh can retry.
      return [new SftpPlaceholderTreeItem(t('SFTP error: {message}', { message: formatError(error) }))];
    }
    const children = (entries ?? []).map((entry) => this.toTreeItem(entry, false));
    return element || state.rootPath === '/' ? children : [new SftpParentDirectoryTreeItem(), ...children];
  }

  private toTreeItem(entry: SftpEntry, disconnected: boolean): SftpTreeNode {
    // A symlink whose target is a directory stays expandable: getChildren lists through
    // entry.path and the server resolves the link. Dangling or file symlinks render as files.
    const isDirectory =
      entry.type === 'directory' || (entry.type === 'symlink' && entry.targetType === 'directory');
    return isDirectory
      ? new SftpDirectoryTreeItem(entry, disconnected)
      : new SftpFileTreeItem(entry, disconnected);
  }
}
