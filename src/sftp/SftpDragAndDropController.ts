import * as vscode from 'vscode';
import { t } from '../i18n/t';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from '../tree/SftpTreeItems';
import type { SftpTreeNode } from '../tree/SftpTreeProvider';
import { dirname } from './RemotePath';
import type { SftpManager } from './SftpManager';
import { uploadLocalEntries, type LocalUploadStat } from './SftpUpload';

export { localUploadFileName } from './SftpUpload';

export function collectDraggedUris(dataTransfer: vscode.DataTransfer): Promise<string[]> {
  return collectDraggedUrisText(dataTransfer);
}

async function collectDraggedUrisText(dataTransfer: vscode.DataTransfer): Promise<string[]> {
  const item = dataTransfer.get('text/uri-list');
  if (!item) {
    return [];
  }
  const text = await item.asString();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export function resolveDropTargetPath(
  target: SftpDirectoryTreeItem | SftpFileTreeItem | undefined,
  rootPath: string
): string {
  if (!target) {
    return rootPath;
  }
  return target instanceof SftpFileTreeItem ? dirname(target.entry.path) : target.entry.path;
}

export interface SftpDragAndDropOptions {
  /** Refresh callback invoked (with the drop target) after at least one entry uploaded. */
  onUploaded?: (target?: SftpTreeNode) => void;
  /** Injectable for tests; defaults to `fs.stat`. */
  statFile?: LocalUploadStat;
}

export class SftpDragAndDropController implements vscode.TreeDragAndDropController<SftpTreeNode> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  private readonly options: SftpDragAndDropOptions;

  constructor(
    private readonly manager: SftpManager,
    options: SftpDragAndDropOptions | ((target?: SftpTreeNode) => void) = {}
  ) {
    this.options = typeof options === 'function' ? { onUploaded: options } : options;
  }

  async handleDrop(
    target: SftpTreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const state = this.manager.getState();
    if (state.kind !== 'active') {
      throw new Error('No connected SSH terminal is active.');
    }
    const uris = await collectDraggedUris(dataTransfer);
    const targetPath =
      target instanceof SftpDirectoryTreeItem || target instanceof SftpFileTreeItem
        ? resolveDropTargetPath(target, state.rootPath)
        : state.rootPath;

    const localPaths: string[] = [];
    let skippedNonFile = false;
    for (const uri of uris) {
      const localUri = vscode.Uri.parse(uri);
      if (localUri.scheme !== 'file') {
        skippedNonFile = true;
        continue;
      }
      localPaths.push(localUri.fsPath);
    }
    if (skippedNonFile) {
      void vscode.window.showWarningMessage(t('Only local files and folders can be uploaded.'));
    }
    if (localPaths.length === 0) {
      return;
    }

    const uploaded = await uploadLocalEntries({
      manager: this.manager,
      localPaths,
      targetDirectory: targetPath,
      statFile: this.options.statFile,
      // The helper uploads entries one by one; refresh once at the end instead of
      // rebuilding the tree for every file in a multi-file drop.
      onUploaded: () => undefined
    });
    if (uploaded > 0) {
      this.options.onUploaded?.(target);
    }
  }
}
