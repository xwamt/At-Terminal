import { describe, expect, it, vi } from 'vitest';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import type { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function server(id = 'server-1'): ServerConfig {
  return {
    id,
    label: id === 'server-1' ? 'Production' : 'Staging',
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

async function call(
  handler: ReturnType<typeof createBridgeRequestHandler>,
  options: {
    path: string;
    method?: string;
    token?: string;
    body?: unknown;
  }
) {
  return handler({
    method: options.method ?? 'POST',
    path: options.path,
    headers: options.token ? { [BRIDGE_TOKEN_HEADER]: options.token } : {},
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

describe('createBridgeRequestHandler', () => {
  it('rejects requests without a valid bridge token', async () => {
    const handler = createBridgeRequestHandler({
      token: 'secret',
      configManager: { listServers: async () => [] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never,
      confirmRun: async () => true
    });

    await expect(call(handler, { path: '/tools/list_ssh_servers' })).resolves.toMatchObject({
      status: 401,
      body: { error: 'Unauthorized MCP bridge request.' }
    });
  });

  it('lists SSH servers without credentials', async () => {
    const handler = createBridgeRequestHandler({
      token: 'secret',
      configManager: { listServers: async () => [server()] } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never,
      confirmRun: async () => true
    });

    await expect(call(handler, { path: '/tools/list_ssh_servers', token: 'secret' })).resolves.toEqual({
      status: 200,
      body: {
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
    });
  });

  it('runs a command against an explicit server after confirmation', async () => {
    const execute = vi.fn(async () => ({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'server-1.example.com',
      command: 'pwd',
      exitCode: 0,
      stdout: '/home/deploy\n',
      stderr: '',
      durationMs: 10,
      timedOut: false,
      truncated: false
    }));
    const confirmRun = vi.fn(async () => true);
    const handler = createBridgeRequestHandler({
      token: 'secret',
      configManager: { getServer: async () => server() } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute } as unknown as RemoteCommandExecutor,
      confirmRun
    });

    const response = await call(handler, {
      path: '/tools/run_remote_command',
      token: 'secret',
      body: { serverId: 'server-1', command: 'pwd', timeoutMs: 1000 }
    });

    expect(confirmRun).toHaveBeenCalledWith(server(), 'pwd');
    expect(execute).toHaveBeenCalledWith(server(), {
      command: 'pwd',
      cwd: undefined,
      timeoutMs: 1000,
      maxOutputBytes: undefined
    });
    expect(response).toMatchObject({
      status: 200,
      body: { stdout: '/home/deploy\n', exitCode: 0 }
    });
  });

  it('resolves active server from the terminal context', async () => {
    const registry = new TerminalContextRegistry();
    registry.setActive({
      terminalId: 'terminal-1',
      server: server('server-2'),
      connected: true,
      write: vi.fn()
    });
    const execute = vi.fn(async () => ({
      serverId: 'server-2',
      serverLabel: 'Staging',
      host: 'server-2.example.com',
      command: 'whoami',
      exitCode: 0,
      stdout: 'deploy\n',
      stderr: '',
      durationMs: 10,
      timedOut: false,
      truncated: false
    }));
    const handler = createBridgeRequestHandler({
      token: 'secret',
      configManager: { getServer: async () => undefined } as never,
      terminalContext: registry,
      executor: { execute } as unknown as RemoteCommandExecutor,
      confirmRun: async () => true
    });

    await call(handler, {
      path: '/tools/run_remote_command',
      token: 'secret',
      body: { serverId: 'active', command: 'whoami' }
    });

    expect(execute).toHaveBeenCalledWith(server('server-2'), {
      command: 'whoami',
      cwd: undefined,
      timeoutMs: undefined,
      maxOutputBytes: undefined
    });
  });

  it('returns a bridge error when user cancels confirmation', async () => {
    const handler = createBridgeRequestHandler({
      token: 'secret',
      configManager: { getServer: async () => server() } as never,
      terminalContext: new TerminalContextRegistry(),
      executor: { execute: vi.fn() } as never,
      confirmRun: async () => false
    });

    await expect(
      call(handler, {
        path: '/tools/run_remote_command',
        token: 'secret',
        body: { serverId: 'server-1', command: 'pwd' }
      })
    ).resolves.toEqual({
      status: 400,
      body: { error: 'Remote command was cancelled.' }
    });
  });
});
