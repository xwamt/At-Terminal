import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import type { z } from 'zod';
import type { AgentToolService } from '../agent/AgentToolService';
import { formatError } from '../utils/errors';
import {
  sftpCreateFileBridgeSchema,
  sftpListDirectoryBridgeSchema,
  sftpPathBridgeSchema,
  sftpReadFileBridgeSchema,
  sftpWriteFileBridgeSchema,
  runRemoteCommandBridgeSchema
} from './bridgeSchemas';
import { removeBridgeDiscovery, writeBridgeDiscovery } from './BridgeDiscovery';
import { BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES, BRIDGE_TOKEN_HEADER } from './BridgeProtocol';

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
  private port: number | undefined;
  private readonly bridgeId = randomUUID();

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
    this.port = address.port;
    await writeBridgeDiscovery(this.home, {
      id: this.bridgeId,
      port: address.port,
      token: this.token,
      pid: process.pid,
      updatedAt: Date.now()
    });
  }

  async dispose(): Promise<void> {
    const server = this.server;
    const port = this.port;
    const token = this.token;
    this.server = undefined;
    this.port = undefined;
    await removeBridgeDiscovery(
      this.home,
      port && token ? { id: this.bridgeId, port, token, pid: process.pid } : undefined
    );
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
        const parsed = parseBodyWithSchema(request.body, runRemoteCommandBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        const command = parsed.data.command.trim();
        if (!command) {
          return json(400, { error: 'Remote command cannot be empty.' });
        }
        try {
          return json(200, await dependencies.service.runRemoteCommand({ ...parsed.data, command }));
        } catch (error) {
          if (error instanceof Error && error.message === 'Remote command was cancelled.') {
            return json(400, { error: error.message });
          }
          throw error;
        }
      }
      if (request.path === '/tools/sftp_list_directory') {
        const parsed = parseBodyWithSchema(request.body, sftpListDirectoryBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpListDirectory(parsed.data));
      }
      if (request.path === '/tools/sftp_stat_path') {
        const parsed = parseBodyWithSchema(request.body, sftpPathBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpStatPath(parsed.data));
      }
      if (request.path === '/tools/sftp_read_file') {
        const parsed = parseBodyWithSchema(request.body, sftpReadFileBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpReadFile(parsed.data));
      }
      if (request.path === '/tools/sftp_write_file') {
        const parsed = parseBodyWithSchema(request.body, sftpWriteFileBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpWriteFile(parsed.data));
      }
      if (request.path === '/tools/sftp_create_file') {
        const parsed = parseBodyWithSchema(request.body, sftpCreateFileBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpCreateFile(parsed.data));
      }
      if (request.path === '/tools/sftp_create_directory') {
        const parsed = parseBodyWithSchema(request.body, sftpPathBridgeSchema);
        if (!parsed.ok) {
          return json(400, { error: parsed.error });
        }
        return json(200, await dependencies.service.sftpCreateDirectory(parsed.data));
      }
      return json(404, { error: 'Unknown AT Terminal MCP bridge endpoint.' });
    } catch (error) {
      return json(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

export function parseBodyWithSchema<T>(
  body: string | undefined,
  schema: z.ZodType<T>
): { ok: true; data: T } | { ok: false; error: string } {
  let raw: unknown = {};
  if (body) {
    try {
      raw = JSON.parse(body);
    } catch {
      return { ok: false, error: 'Invalid JSON body.' };
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
    };
  }
  return { ok: true, data: parsed.data };
}

export async function readLimitedBody(
  request: AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
  maxBytes: number
): Promise<{ ok: true; body: string } | { ok: false; status: 413; error: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) {
      return { ok: false, status: 413, error: `Request body exceeds ${maxBytes} bytes.` };
    }
    chunks.push(buf);
  }
  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
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
    const limited = await readLimitedBody(request, BRIDGE_MAX_BODY_BYTES);
    if (!limited.ok) {
      response.statusCode = limited.status;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ error: limited.error }));
      return;
    }
    const result = await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      headers: request.headers,
      body: limited.body
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
