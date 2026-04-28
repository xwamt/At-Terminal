import * as vscode from 'vscode';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from '../tree/SftpTreeItems';
import type { SftpTreeNode } from '../tree/SftpTreeProvider';
import { dirname, joinRemotePath, safePreviewName } from './RemotePath';
import type { SftpManager } from './SftpManager';

export function localUploadFileName(localPath: string): string {
  return localPath.split(/[\\/]/).filter(Boolean).pop() ?? safePreviewName(localPath);
}

export async function collectDraggedUris(dataTransfer: vscode.DataTransfer): Promise<string[]> {
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

export class SftpDragAndDropController implements vscode.TreeDragAndDropController<SftpTreeNode> {
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  constructor(private readonly manager: SftpManager) {}

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

    for (const uri of uris) {
      const localUri = vscode.Uri.parse(uri);
      await this.manager.uploadFile(localUri.fsPath, joinRemotePath(targetPath, localUploadFileName(localUri.fsPath)));
    }
  }
}
