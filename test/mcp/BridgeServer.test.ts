import { describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import { createBridgeRequestHandler, readLimitedBody } from '../../src/mcp/BridgeServer';
import { BRIDGE_MAX_BODY_BYTES, BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';
import { AT_TERMINAL_PLUGIN_ID, AT_TERMINAL_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

async function call(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  options: {
    path: string;
    method?: string;
    token?: string;
    tokenHeader?: string;
    body?: unknown;
  }
) {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers[options.tokenHeader ?? AT_SERIES_TOKEN_HEADER] = options.token;
  }
  return handler({
    method: options.method ?? 'GET',
    path: options.path,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

function createHandler(
  overrides: {
    token?: string;
    service?: Record<string, unknown>;
    hostApp?: string;
    bridgeId?: string;
    pluginVersion?: string;
  } = {}
) {
  return createBridgeRequestHandler({
    token: overrides.token ?? 'secret',
    bridgeId: overrides.bridgeId ?? 'bridge-1',
    hostApp: (overrides.hostApp ?? 'cursor') as 'cursor',
    pluginVersion: overrides.pluginVersion ?? '0.3.0',
    service: {
      listServers: async () => ({ servers: [] }),
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
      runRemoteCommand: vi.fn(),
      ...overrides.service
    } as never
  });
}

describe('createBridgeRequestHandler', () => {
  it('rejects requests without a valid series token', async () => {
    const handler = createHandler();

    await expect(call(handler, { path: '/health' })).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
    await expect(
      call(handler, { path: '/health', token: 'wrong', tokenHeader: AT_SERIES_TOKEN_HEADER })
    ).resolves.toMatchObject({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED' } }
    });
  });

  it('accepts legacy x-at-terminal-token during migration', async () => {
    const handler = createHandler();

    await expect(
      call(handler, {
        path: '/health',
        token: 'secret',
        tokenHeader: BRIDGE_TOKEN_HEADER
      })
    ).resolves.toMatchObject({
      status: 200,
      body: { ok: true, protocolVersion: 1 }
    });
  });

  it('returns rich health shape with protocolVersion and pluginId', async () => {
    const handler = createHandler({
      service: {
        getTerminalContext: async () => ({
          connectedTerminals: [{ terminalId: 't1' }, { terminalId: 't2' }],
          knownTerminals: []
        })
      }
    });

    await expect(
      call(handler, { path: '/health', token: 'secret', tokenHeader: AT_SERIES_TOKEN_HEADER })
    ).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        protocolVersion: 1,
        bridgeId: 'bridge-1',
        pluginId: AT_TERMINAL_PLUGIN_ID,
        pluginDisplayName: 'AT Terminal',
        pluginVersion: '0.3.0',
        hostApp: 'cursor',
        pid: process.pid,
        updatedAt: expect.any(Number),
        connectedTargets: 2,
        toolCount: AT_TERMINAL_TOOL_CATALOG.length
      }
    });
  });

  it('lists tools with risk fields', async () => {
    const handler = createHandler();

    const response = await call(handler, {
      path: '/tools',
      token: 'secret',
      tokenHeader: AT_SERIES_TOKEN_HEADER
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ protocolVersion: 1 });
    const tools = (response.body as { tools: Array<{ name: string; risk: string }> }).tools;
    expect(tools).toEqual(AT_TERMINAL_TOOL_CATALOG);
    expect(tools.every((tool) => typeof tool.risk === 'string')).toBe(true);
    expect(tools.find((tool) => tool.name === 'list_ssh_servers')?.risk).toBe('read');
    expect(tools.find((tool) => tool.name === 'run_remote_command')?.risk).toBe('exec');
  });

  it('invokes list_ssh_servers through POST /invoke', async () => {
    const service = {
      listServers: vi.fn(async () => ({
        servers: [
          {
            id: 'server-1',
            label: 'Production',
            host: 'server-1.example.com',
            port: 22,
            username: 'deploy',
            authType: 'password'
          }
        ]
      })),
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
      runRemoteCommand: vi.fn()
    };
    const handler = createHandler({ service });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        tokenHeader: AT_SERIES_TOKEN_HEADER,
        body: { name: 'list_ssh_servers', arguments: {} }
      })
    ).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        name: 'list_ssh_servers',
        result: {
          servers: [
            {
              id: 'server-1',
              label: 'Production',
              host: 'server-1.example.com',
              port: 22,
              username: 'deploy',
              authType: 'password'
            }
          ]
        }
      }
    });
    expect(service.listServers).toHaveBeenCalledOnce();
  });

  it('returns terminal context through invoke', async () => {
    const handler = createHandler({
      service: {
        getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] })
      }
    });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'get_terminal_context', arguments: {} }
      })
    ).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        name: 'get_terminal_context',
        result: { connectedTerminals: [], knownTerminals: [] }
      }
    });
  });

  it('runs a command through invoke', async () => {
    const service = {
      runRemoteCommand: vi.fn(async () => ({ stdout: '/home/deploy\n', exitCode: 0 }))
    };
    const handler = createHandler({ service });

    const response = await call(handler, {
      method: 'POST',
      path: '/invoke',
      token: 'secret',
      body: {
        name: 'run_remote_command',
        arguments: { serverId: 'server-1', command: ' pwd ', timeoutMs: 1000 }
      }
    });

    expect(service.runRemoteCommand).toHaveBeenCalledWith({
      serverId: 'server-1',
      command: 'pwd',
      timeoutMs: 1000
    });
    expect(response).toMatchObject({
      status: 200,
      body: {
        ok: true,
        name: 'run_remote_command',
        result: { stdout: '/home/deploy\n', exitCode: 0 }
      }
    });
  });

  it('routes sftp tools through invoke', async () => {
    const service = {
      sftpReadFile: vi.fn(async () => ({ content: 'hello' })),
      sftpWriteFile: vi.fn(async () => ({ bytesWritten: 5 }))
    };
    const handler = createHandler({ service });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'sftp_read_file', arguments: { path: '/app.txt' } }
      })
    ).resolves.toEqual({
      status: 200,
      body: { ok: true, name: 'sftp_read_file', result: { content: 'hello' } }
    });
    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'sftp_write_file', arguments: { path: '/app.txt', content: 'hello' } }
      })
    ).resolves.toEqual({
      status: 200,
      body: { ok: true, name: 'sftp_write_file', result: { bytesWritten: 5 } }
    });
  });

  it('returns USER_CANCELLED when user cancels confirmation', async () => {
    const handler = createHandler({
      service: {
        runRemoteCommand: async () => {
          throw new Error('Remote command was cancelled.');
        }
      }
    });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'run_remote_command', arguments: { serverId: 'server-1', command: 'pwd' } }
      })
    ).resolves.toMatchObject({
      status: 499,
      body: { error: { code: 'USER_CANCELLED', message: 'Remote command was cancelled.' } }
    });
  });

  it('returns 422 VALIDATION_ERROR when invoke args fail schema validation', async () => {
    const handler = createHandler({
      service: {
        sftpStatPath: vi.fn()
      }
    });

    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'sftp_stat_path', arguments: { path: 123 } }
      })
    ).resolves.toMatchObject({
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR', message: expect.stringMatching(/path|invalid|expected/i) } }
    });
  });

  it('returns 422 when run_remote_command is missing command', async () => {
    const handler = createHandler({
      service: { runRemoteCommand: vi.fn() }
    });
    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'run_remote_command', arguments: {} }
      })
    ).resolves.toMatchObject({
      status: 422,
      body: { error: { code: 'VALIDATION_ERROR' } }
    });
  });

  it('returns 404 NOT_FOUND for unknown tools', async () => {
    const handler = createHandler();
    await expect(
      call(handler, {
        method: 'POST',
        path: '/invoke',
        token: 'secret',
        body: { name: 'does_not_exist', arguments: {} }
      })
    ).resolves.toMatchObject({
      status: 404,
      body: { error: { code: 'NOT_FOUND' } }
    });
  });
});

describe('readLimitedBody', () => {
  it('rejects bodies larger than BRIDGE_MAX_BODY_BYTES', async () => {
    const big = 'x'.repeat(BRIDGE_MAX_BODY_BYTES + 1);
    const result = await readLimitedBody([Buffer.from(big)], BRIDGE_MAX_BODY_BYTES);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
    }
  });

  it('accepts bodies within the limit', async () => {
    const result = await readLimitedBody([Buffer.from('{"ok":true}')], BRIDGE_MAX_BODY_BYTES);
    expect(result).toEqual({ ok: true, body: '{"ok":true}' });
  });
});
