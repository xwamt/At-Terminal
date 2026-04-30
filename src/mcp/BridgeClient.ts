import { homedir } from 'node:os';
import { readBridgeDiscovery } from './BridgeDiscovery';
import {
  BRIDGE_HOST,
  BRIDGE_TOKEN_HEADER,
  type GetTerminalContextBridgeResponse,
  type ListSshServersBridgeResponse,
  type RunRemoteCommandBridgeRequest
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

  private async call<T>(path: string, body: unknown): Promise<T> {
    const discovery = await readBridgeDiscovery(this.options.home ?? homedir());
    if (!discovery) {
      throw new Error(
        'AT Terminal MCP bridge is not running. Open VS Code with the AT Terminal extension installed, then reload this MCP server.'
      );
    }

    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(`http://${BRIDGE_HOST}:${discovery.port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: discovery.token
      },
      body: JSON.stringify(body)
    });

    const parsed = await response.json();
    if (!response.ok) {
      const message =
        typeof parsed === 'object' && parsed !== null && 'error' in parsed
          ? String(parsed.error)
          : `Bridge request failed with HTTP ${response.status}.`;
      throw new Error(message);
    }

    return parsed as T;
  }
}
