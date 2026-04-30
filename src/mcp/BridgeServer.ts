import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { AgentToolService } from '../agent/AgentToolService';
import { formatError } from '../utils/errors';
import { removeBridgeDiscovery, writeBridgeDiscovery } from './BridgeDiscovery';
import { BRIDGE_HOST, BRIDGE_TOKEN_HEADER, type RunRemoteCommandBridgeRequest } from './BridgeProtocol';

export interface BridgeHandlerDependencies {
  service: AgentToolService;
  token: string;
}

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

export class BridgeServer {
  private server: Server | undefined;
  private token = '';

  constructor(
    private readonly service: AgentToolService,
    private readonly home = homedir()
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    const handler = createBridgeRequestHandler({
      service: this.service,
      token: this.token
    });
    this.server = createServer((request, response) => {
      void handleNodeRequest(handler, request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, BRIDGE_HOST, () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT Terminal MCP bridge.');
    }
    await writeBridgeDiscovery(this.home, {
      port: address.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now()
    });
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    await removeBridgeDiscovery(this.home);
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export function createBridgeRequestHandler(dependencies: BridgeHandlerDependencies) {
  return async (request: BridgeRequest): Promise<BridgeResponse> => {
    try {
      if (request.headers[BRIDGE_TOKEN_HEADER] !== dependencies.token) {
        return json(401, { error: 'Unauthorized MCP bridge request.' });
      }
      if (request.path === '/health') {
        return json(200, { ok: true });
      }
      if (request.method !== 'POST') {
        return json(405, { error: 'Method not allowed.' });
      }
      if (request.path === '/tools/list_ssh_servers') {
        return json(200, await dependencies.service.listServers());
      }
      if (request.path === '/tools/get_terminal_context') {
        return json(200, await dependencies.service.getTerminalContext());
      }
      if (request.path === '/tools/run_remote_command') {
        const input = parseBody<RunRemoteCommandBridgeRequest>(request.body);
        const command = input.command?.trim();
        if (!command) {
          return json(400, { error: 'Remote command cannot be empty.' });
        }
        try {
          return json(200, await dependencies.service.runRemoteCommand({ ...input, command }));
        } catch (error) {
          if (error instanceof Error && error.message === 'Remote command was cancelled.') {
            return json(400, { error: error.message });
          }
          throw error;
        }
      }
      if (request.path === '/tools/sftp_list_directory') {
        return json(200, await dependencies.service.sftpListDirectory(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_stat_path') {
        return json(200, await dependencies.service.sftpStatPath(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_read_file') {
        return json(200, await dependencies.service.sftpReadFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_write_file') {
        return json(200, await dependencies.service.sftpWriteFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_create_file') {
        return json(200, await dependencies.service.sftpCreateFile(parseBody(request.body)));
      }
      if (request.path === '/tools/sftp_create_directory') {
        return json(200, await dependencies.service.sftpCreateDirectory(parseBody(request.body)));
      }
      return json(404, { error: 'Unknown AT Terminal MCP bridge endpoint.' });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

function parseBody<T>(body: string | undefined): T {
  if (!body) {
    return {} as T;
  }
  return JSON.parse(body) as T;
}

function json(status: number, body: unknown): BridgeResponse {
  return { status, body };
}

async function handleNodeRequest(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const result = await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8')
    });
    response.statusCode = result.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(result.body));
  } catch (error) {
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ error: formatError(error) }));
  }
}
