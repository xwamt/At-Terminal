import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { RemoteCommandExecutor } from '../agent/RemoteCommandExecutor';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { removeBridgeDiscovery, writeBridgeDiscovery } from './BridgeDiscovery';
import { BRIDGE_HOST, BRIDGE_TOKEN_HEADER, type RunRemoteCommandBridgeRequest } from './BridgeProtocol';

export interface BridgeServerDependencies {
  configManager: ConfigManager;
  terminalContext: TerminalContextRegistry;
  executor: RemoteCommandExecutor;
}

export interface BridgeHandlerDependencies extends BridgeServerDependencies {
  token: string;
  confirmRun(server: ServerConfig, command: string): Promise<boolean>;
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
    private readonly dependencies: BridgeServerDependencies,
    private readonly home = homedir()
  ) {}

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.token = randomBytes(32).toString('hex');
    const handler = createBridgeRequestHandler({
      ...this.dependencies,
      token: this.token,
      confirmRun: confirmRemoteCommand
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
        const servers = await dependencies.configManager.listServers();
        return json(200, {
          servers: servers.map((server) => ({
            id: server.id,
            label: server.label,
            host: server.host,
            port: server.port,
            username: server.username,
            authType: server.authType
          }))
        });
      }
      if (request.path === '/tools/run_remote_command') {
        const input = parseBody<RunRemoteCommandBridgeRequest>(request.body);
        const command = input.command?.trim();
        if (!command) {
          return json(400, { error: 'Remote command cannot be empty.' });
        }
        const server = await resolveServer(dependencies, input.serverId);
        if (!(await dependencies.confirmRun(server, command))) {
          return json(400, { error: 'Remote command was cancelled.' });
        }
        const result = await dependencies.executor.execute(server, {
          command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          maxOutputBytes: input.maxOutputBytes
        });
        return json(200, result);
      }
      return json(404, { error: 'Unknown AT Terminal MCP bridge endpoint.' });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

async function resolveServer(
  dependencies: BridgeHandlerDependencies,
  serverId: string | undefined
): Promise<ServerConfig> {
  if (serverId === 'active' || !serverId) {
    const connected = dependencies.terminalContext.getConnectedTerminal();
    if (connected) {
      return connected.server;
    }
    if (serverId === 'active') {
      throw new Error('No connected active SSH terminal is available.');
    }
  }
  if (!serverId) {
    throw new Error('serverId is required when there is no connected active SSH terminal.');
  }
  const server = await dependencies.configManager.getServer(serverId);
  if (!server) {
    throw new Error(`SSH server "${serverId}" was not found.`);
  }
  return server;
}

async function confirmRemoteCommand(server: ServerConfig, command: string): Promise<boolean> {
  const warning = isObviouslyDestructive(command) ? '\n\nWarning: this command appears destructive.' : '';
  const answer = await vscode.window.showWarningMessage(
    `Run remote command on ${server.label} (${server.host})?\n\n${command}${warning}`,
    { modal: true },
    'Run Command'
  );
  return answer === 'Run Command';
}

function isObviouslyDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
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
