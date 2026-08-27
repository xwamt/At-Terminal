import type { ServerConfig } from '../config/schema';

export type SftpEntryType = 'file' | 'directory' | 'symlink';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  /**
   * What a symlink resolves to, so a symlinked directory stays expandable in the tree.
   * Only populated for `type === 'symlink'`; undefined when the target could not be
   * stat-ed (dangling link).
   */
  targetType?: 'file' | 'directory';
  size?: number;
  modifiedAt?: number;
}

export interface SftpFileStat {
  size: number;
  modifiedAt: number;
}

export interface SftpSnapshot {
  server: ServerConfig;
  rootPath: string;
  entriesByPath: Map<string, SftpEntry[]>;
  connected: boolean;
}

export interface PasswordSource {
  getPassword(serverId: string): Promise<string | undefined>;
  getServer?(serverId: string): Promise<ServerConfig | undefined>;
}
