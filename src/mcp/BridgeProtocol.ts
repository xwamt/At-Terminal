import type { TerminalContextSnapshot } from '../terminal/TerminalContext';

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_TOKEN_HEADER = 'x-at-terminal-token';
export const BRIDGE_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BRIDGE_SELECTION_CACHE_MS = 1500;

export interface BridgeDiscovery {
  id?: string;
  port: number;
  token: string;
  pid: number;
  updatedAt: number;
}

export interface BridgeServerSummary {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: 'password' | 'privateKey';
}

export interface ListSshServersBridgeResponse {
  servers: BridgeServerSummary[];
}

export type GetTerminalContextBridgeResponse = TerminalContextSnapshot;

export interface RunRemoteCommandBridgeRequest {
  serverId?: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SftpTargetBridgeRequest {
  terminalId?: string;
  serverId?: string;
}

export interface SftpPathBridgeRequest extends SftpTargetBridgeRequest {
  path: string;
}

export interface SftpListDirectoryBridgeRequest extends SftpTargetBridgeRequest {
  path?: string;
}

export interface SftpReadFileBridgeRequest extends SftpPathBridgeRequest {
  maxBytes?: number;
}

export interface SftpWriteFileBridgeRequest extends SftpPathBridgeRequest {
  content: string;
  overwrite?: boolean;
}

export interface SftpCreateFileBridgeRequest extends SftpPathBridgeRequest {
  content?: string;
}

export interface BridgeErrorResponse {
  error: string;
}

