import type { HostApp } from '@at-series/mcp-hub';
import {
  AT_SERIES_PROTOCOL_VERSION,
  AT_SERIES_TOKEN_HEADER,
  BRIDGE_HOST,
  BRIDGE_MAX_BODY_BYTES
} from '@at-series/mcp-hub';
import type { TerminalContextSnapshot } from '../terminal/TerminalContext';

export { AT_SERIES_TOKEN_HEADER, BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES, AT_SERIES_PROTOCOL_VERSION };

/** Legacy auth header accepted during AT Series migration. */
export const BRIDGE_TOKEN_HEADER = 'x-at-terminal-token';

export const AT_TERMINAL_PLUGIN_DISPLAY_NAME = 'AT Terminal';

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
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type { HostApp };
