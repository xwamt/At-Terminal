import { joinRemotePath, dirname } from './RemotePath';
import type { SftpEntry } from './SftpTypes';

export interface CreateRemoteFileForEditingOptions {
  entry?: Pick<SftpEntry, 'path' | 'type'>;
  rootPath: string;
  promptName(): Promise<string | undefined>;
  createFile(remotePath: string): Promise<void>;
  openRemoteFile(remotePath: string): Promise<void>;
  refresh(): void;
}

export async function createRemoteFileForEditing(
  options: CreateRemoteFileForEditingOptions
): Promise<string | undefined> {
  const fileName = await options.promptName();
  if (!fileName) {
    return undefined;
  }

  const targetDirectory = getNewFileTargetDirectory(options.entry, options.rootPath);
  const remotePath = joinRemotePath(targetDirectory, fileName);
  await options.createFile(remotePath);
  options.refresh();
  await options.openRemoteFile(remotePath);
  return remotePath;
}

function getNewFileTargetDirectory(
  entry: Pick<SftpEntry, 'path' | 'type'> | undefined,
  rootPath: string
): string {
  if (!entry) {
    return rootPath;
  }
  return entry.type === 'directory' ? entry.path : dirname(entry.path);
}
