import { stat as statLocal } from 'node:fs/promises';
import * as vscode from 'vscode';
import { t } from '../i18n/t';
import { joinRemotePath } from './RemotePath';
import { isSftpConflictError } from './SftpErrors';
import type { SftpManager } from './SftpManager';

export function localUploadFileName(localPath: string): string {
  return localPath.split(/[\\/]/).filter(Boolean).pop() ?? localPath;
}

export type LocalUploadStat = (path: string) => Promise<{ isDirectory(): boolean }>;

export interface UploadLocalEntriesOptions {
  manager: Pick<SftpManager, 'uploadFile' | 'uploadDirectory'>;
  localPaths: string[];
  targetDirectory: string;
  /** Injectable for tests; defaults to `fs.stat`. */
  statFile?: LocalUploadStat;
  /** Called after each successful entry, e.g. to refresh the tree. */
  onUploaded?: (localPath: string) => void;
}

/**
 * Uploads local files and directories into one remote directory, asking the shared
 * Overwrite / Overwrite All / Skip question when a name already exists. Shared by the
 * `sshManager.sftp.upload` command and drag-and-drop so both behave identically.
 */
export async function uploadLocalEntries(options: UploadLocalEntriesOptions): Promise<number> {
  const statFile = options.statFile ?? ((path) => statLocal(path));
  let overwriteAll = false;
  let uploaded = 0;
  for (const localPath of options.localPaths) {
    const remotePath = joinRemotePath(options.targetDirectory, localUploadFileName(localPath));
    const localStat = await statFile(localPath);
    const upload = async (overwrite: boolean): Promise<void> => {
      if (localStat.isDirectory()) {
        await options.manager.uploadDirectory(localPath, remotePath, undefined, { overwrite });
        return;
      }
      await options.manager.uploadFile(localPath, remotePath, undefined, { overwrite });
    };
    try {
      await upload(overwriteAll);
      uploaded += 1;
      options.onUploaded?.(localPath);
    } catch (error) {
      if (!isSftpConflictError(error)) {
        throw error;
      }
      const overwrite = t('Overwrite');
      const overwriteEverything = t('Overwrite All');
      const skip = t('Skip');
      const choice = await vscode.window.showWarningMessage(
        error.message,
        { modal: true },
        overwrite,
        overwriteEverything,
        skip
      );
      if (choice === overwrite || choice === overwriteEverything) {
        overwriteAll = choice === overwriteEverything;
        await upload(true);
        uploaded += 1;
        options.onUploaded?.(localPath);
      }
    }
  }
  return uploaded;
}
