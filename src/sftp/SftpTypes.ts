import type { ServerConfig } from '../config/schema';

export type SftpEntryType = 'file' | 'directory' | 'symlink';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
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
}
