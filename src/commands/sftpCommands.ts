import { join as joinLocalPath } from 'node:path';
import * as vscode from 'vscode';
import { dirname, joinRemotePath, quotePosixShellPath } from '../sftp/RemotePath';
import { SftpEditCancelledError } from '../sftp/SftpEditSessionManager';
import { createRemoteFileForEditing } from '../sftp/SftpNewFile';
import { SftpPreviewCancelledError, openRemotePreviewFile } from '../sftp/SftpPreview';
import { uploadLocalEntries } from '../sftp/SftpUpload';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from '../tree/SftpTreeItems';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import type { CommandContext } from './commandContext';
import { refreshSftpFilesView } from '../extension/wiring';

export function registerSftpCommands(ctx: CommandContext): vscode.Disposable[] {
  const {
    context,
    sftpManager,
    sftpTreeProvider,
    sftpEditManager,
    sftpPreviewStore,
    terminalContext
  } = ctx;

  const run = async (command: () => Promise<void>): Promise<void> => {
    try {
      await command();
    } catch (error) {
      // Declining a large/binary file prompt is a decision, not a failure.
      if (error instanceof SftpEditCancelledError || error instanceof SftpPreviewCancelledError) {
        return;
      }
      // Errors stay on screen until dismissed; only success toasts self-dismiss.
      void vscode.window.showErrorMessage(formatError(error));
    }
  };

  return [
    vscode.commands.registerCommand('sshManager.sftp.refresh', () => {
      refreshSftpFilesView({
        terminalContext,
        sftpManager,
        refreshSftpTree: () => sftpTreeProvider.refresh()
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.goToPath', async () => {
      await run(async () => {
        const state = sftpManager.getState();
        const currentPath = state.kind === 'active' ? state.rootPath : '';
        const nextPath = await vscode.window.showInputBox({
          prompt: t('Remote path'),
          value: currentPath
        });
        if (!nextPath?.trim()) {
          return;
        }
        await sftpManager.changeDirectory(nextPath.trim());
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.goUp', async () => {
      await run(async () => {
        await sftpManager.changeToParentDirectory();
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.upload', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        const files = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true
        });
        if (!files?.length) {
          return;
        }
        const state = sftpManager.getState();
        const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
        await uploadLocalEntries({
          manager: sftpManager,
          localPaths: files.map((file) => file.fsPath),
          targetDirectory
        });
        sftpTreeProvider.refresh(item instanceof SftpDirectoryTreeItem ? item : undefined);
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.download', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        if (!item) {
          return;
        }
        if (item.entry.type === 'directory' || item.entry.targetType === 'directory') {
          const folders = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: t('Download Here')
          });
          if (!folders?.length) {
            return;
          }
          await sftpManager.downloadDirectory(item.entry.path, joinLocalPath(folders[0].fsPath, item.entry.name));
          return;
        }
        const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(item.entry.name) });
        if (!destination) {
          return;
        }
        await sftpManager.downloadFile(item.entry.path, destination.fsPath);
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.delete', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        if (!item) {
          return;
        }
        const deleteAction = t('Delete');
        // Symlinked directories stay expandable in the tree, but deleteEntry only
        // unlinks the symlink. Count-through-target copy would overstate the damage.
        const message =
          item.entry.type === 'directory'
            ? t('Delete remote directory "{path}"? {count} entries will be permanently deleted.', {
                path: item.entry.path,
                count: await sftpManager.countDeletableEntries(item.entry.path)
              })
            : t('Delete remote {type} "{path}"?', { type: item.entry.type, path: item.entry.path });
        const answer = await vscode.window.showWarningMessage(message, { modal: true }, deleteAction);
        if (answer === deleteAction) {
          await sftpManager.deleteEntry(item.entry);
          sftpTreeProvider.refresh();
        }
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.rename', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        if (!item) {
          return;
        }
        const nextName = await vscode.window.showInputBox({
          prompt: t('New remote name'),
          value: item.entry.name
        });
        if (!nextName || nextName === item.entry.name) {
          return;
        }
        await sftpManager.rename(item.entry.path, joinRemotePath(dirname(item.entry.path), nextName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.newFile', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        const state = sftpManager.getState();
        await createRemoteFileForEditing({
          entry: item?.entry,
          rootPath: state.kind === 'active' ? state.rootPath : '.',
          promptName: async () => vscode.window.showInputBox({ prompt: t('New remote file name') }),
          createFile: (remotePath) => sftpManager.createFile(remotePath),
          openRemoteFile: async (remotePath) => {
            await sftpEditManager.openRemoteFile(remotePath);
          },
          refresh: () => sftpTreeProvider.refresh()
        });
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.newFolder', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      await run(async () => {
        const folderName = await vscode.window.showInputBox({ prompt: t('New remote folder name') });
        if (!folderName) {
          return;
        }
        const state = sftpManager.getState();
        const targetDirectory = getTargetDirectory(item, state.kind === 'active' ? state.rootPath : '.');
        await sftpManager.mkdir(joinRemotePath(targetDirectory, folderName));
        sftpTreeProvider.refresh();
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.copyPath', async (item?: SftpDirectoryTreeItem | SftpFileTreeItem) => {
      if (item) {
        await vscode.env.clipboard.writeText(item.entry.path);
      }
    }),
    vscode.commands.registerCommand('sshManager.sftp.edit', async (item?: SftpFileTreeItem) => {
      await run(async () => {
        if (!item) {
          return;
        }
        await sftpEditManager.openRemoteFile(item.entry.path);
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.openPreview', async (item?: SftpFileTreeItem) => {
      await run(async () => {
        if (!item) {
          return;
        }
        await openRemotePreviewFile({
          storageUri: context.globalStorageUri,
          remotePath: item.entry.path,
          previewStore: sftpPreviewStore,
          downloadFile: (remotePath, localPath) => sftpManager.downloadFile(remotePath, localPath),
          statFile: (remotePath) => sftpManager.stat(remotePath),
          confirmOpen: async (remotePath, size, limitBytes) => {
            const openAction = t('Open Anyway');
            const cancelAction = t('Cancel');
            const answer = await vscode.window.showWarningMessage(
              t(
                '{remotePath} is {size} bytes and may be a large or binary file (soft limit {limit} bytes). Open a text preview anyway, or download it instead?',
                { remotePath, size, limit: limitBytes }
              ),
              { modal: true },
              openAction,
              cancelAction
            );
            return answer === openAction;
          },
          openUri: async (uri, openOptions) => {
            await vscode.commands.executeCommand('vscode.open', uri, openOptions);
          }
        });
      });
    }),
    vscode.commands.registerCommand('sshManager.sftp.cdToDirectory', (item?: SftpDirectoryTreeItem) => {
      if (item) {
        terminalContext.getActive()?.write(`cd ${quotePosixShellPath(item.entry.path)}\r`);
      }
    })
  ];
}

function getTargetDirectory(
  item: SftpDirectoryTreeItem | SftpFileTreeItem | undefined,
  rootPath: string
): string {
  if (!item) {
    return rootPath;
  }
  return item instanceof SftpFileTreeItem ? dirname(item.entry.path) : item.entry.path;
}
