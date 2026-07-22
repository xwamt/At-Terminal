import { homedir } from 'node:os';
import { listBridgeDiscoveries } from './BridgeDiscovery';
import {
  BRIDGE_HOST,
  BRIDGE_SELECTION_CACHE_MS,
  BRIDGE_TOKEN_HEADER,
  type BridgeDiscovery,
  type GetTerminalContextBridgeResponse,
  type ListSshServersBridgeResponse,
  type RunRemoteCommandBridgeRequest,
  type SftpCreateFileBridgeRequest,
  type SftpListDirectoryBridgeRequest,
  type SftpPathBridgeRequest,
  type SftpReadFileBridgeRequest,
  type SftpWriteFileBridgeRequest
} from './BridgeProtocol';

interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  }
) => Promise<FetchLikeResponse>;

export class BridgeClient {
  private activeDiscovery: BridgeDiscovery | undefined;
  private activeExpiresAt = 0;

  constructor(
    private readonly options: {
      home?: string;
      fetch?: FetchLike;
    } = {}
  ) {}

  async listServers(): Promise<ListSshServersBridgeResponse> {
    return this.call<ListSshServersBridgeResponse>('/tools/list_ssh_servers', {});
  }

  async getTerminalContext(): Promise<GetTerminalContextBridgeResponse> {
    return this.call<GetTerminalContextBridgeResponse>('/tools/get_terminal_context', {});
  }

  async runRemoteCommand(input: RunRemoteCommandBridgeRequest): Promise<unknown> {
    return this.call('/tools/run_remote_command', input);
  }

  async sftpListDirectory(input: SftpListDirectoryBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_list_directory', input);
  }

  async sftpStatPath(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_stat_path', input);
  }

  async sftpReadFile(input: SftpReadFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_read_file', input);
  }

  async sftpWriteFile(input: SftpWriteFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_write_file', input);
  }

  async sftpCreateFile(input: SftpCreateFileBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_create_file', input);
  }

  async sftpCreateDirectory(input: SftpPathBridgeRequest): Promise<unknown> {
    return this.call('/tools/sftp_create_directory', input);
  }

  private clearActiveDiscovery(): void {
    this.activeDiscovery = undefined;
    this.activeExpiresAt = 0;
  }

  private async resolveDiscovery(fetchImpl: FetchLike): Promise<BridgeDiscovery> {
    const now = Date.now();
    if (this.activeDiscovery && now < this.activeExpiresAt) {
      return this.activeDiscovery;
    }

    const home = this.options.home ?? homedir();
    const candidates = await listBridgeDiscoveries(home);
    if (candidates.length === 0) {
      throw new Error(
        'AT Terminal MCP bridge is not running. Open VS Code with the AT Terminal extension installed, then reload this MCP server.'
      );
    }

    let best: { discovery: BridgeDiscovery; score: number } | undefined;
    for (const discovery of candidates) {
      try {
        const health = await fetchImpl(`http://${BRIDGE_HOST}:${discovery.port}/health`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [BRIDGE_TOKEN_HEADER]: discovery.token
          },
          body: '{}'
        });
        if (!health.ok) {
          continue;
        }

        const contextResponse = await fetchImpl(
          `http://${BRIDGE_HOST}:${discovery.port}/tools/get_terminal_context`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              [BRIDGE_TOKEN_HEADER]: discovery.token
            },
            body: '{}'
          }
        );
        if (!contextResponse.ok) {
          continue;
        }
        const context = (await contextResponse.json()) as {
          connectedTerminals?: unknown[];
        };
        const connectedCount = Array.isArray(context.connectedTerminals)
          ? context.connectedTerminals.length
          : 0;
        const score = connectedCount > 0 ? 2 : 1;
        if (!best || score > best.score) {
          best = { discovery, score };
        }
        if (score === 2) {
          break;
        }
      } catch {
        // try next candidate
      }
    }

    if (!best) {
      throw new Error(
        'AT Terminal MCP bridge is not reachable. Reload VS Code with AT Terminal running, then retry.'
      );
    }

    this.activeDiscovery = best.discovery;
    this.activeExpiresAt = Date.now() + BRIDGE_SELECTION_CACHE_MS;
    return best.discovery;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const fetchImpl = this.options.fetch ?? fetch;
    for (let attempt = 0; attempt < 3; attempt++) {
      let discovery: BridgeDiscovery;
      try {
        discovery = await this.resolveDiscovery(fetchImpl);
      } catch (error) {
        if (attempt < 2) {
          this.clearActiveDiscovery();
          await delayBridgeRetry();
          continue;
        }
        throw error;
      }

      let response: FetchLikeResponse;
      try {
        response = await fetchImpl(`http://${BRIDGE_HOST}:${discovery.port}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [BRIDGE_TOKEN_HEADER]: discovery.token
          },
          body: JSON.stringify(body)
        });
      } catch {
        this.clearActiveDiscovery();
        if (attempt < 2) {
          await delayBridgeRetry();
          continue;
        }
        throw new Error(
          'AT Terminal MCP bridge is not reachable. Reload VS Code with AT Terminal running, then retry.'
        );
      }

      const parsed = await parseJsonResponse(response);
      if (response.ok) {
        return parsed as T;
      }
      if (response.status === 401 && attempt < 2) {
        this.clearActiveDiscovery();
        await delayBridgeRetry();
        continue;
      }
      const message =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String(parsed.error)
          : `Bridge request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    throw new Error(
      'AT Terminal MCP bridge is not reachable. Reload VS Code with AT Terminal running, then retry.'
    );
  }
}

function delayBridgeRetry(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

async function parseJsonResponse(response: FetchLikeResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (!response.ok) {
      throw new Error(`Bridge request failed with HTTP ${response.status}.`);
    }
    throw new Error('AT Terminal MCP bridge returned an invalid JSON response.');
  }
}
