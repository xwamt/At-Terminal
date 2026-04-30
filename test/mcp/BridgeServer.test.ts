import { describe, expect, it, vi } from 'vitest';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

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
      service: {
        listServers: async () => ({ servers: [] }),
        getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
        runRemoteCommand: vi.fn()
      } as never
    });

    await expect(call(handler, { path: '/tools/list_ssh_servers' })).resolves.toMatchObject({
      status: 401,
      body: { error: 'Unauthorized MCP bridge request.' }
    });
  });

  it('lists SSH servers through the service', async () => {
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
    const handler = createBridgeRequestHandler({ token: 'secret', service: service as never });

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
    expect(service.listServers).toHaveBeenCalledOnce();
  });

  it('returns terminal context through the bridge', async () => {
    const handler = createBridgeRequestHandler({
      token: 'secret',
      service: {
        getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] })
      } as never
    });

    await expect(call(handler, { path: '/tools/get_terminal_context', token: 'secret' })).resolves.toEqual({
      status: 200,
      body: { connectedTerminals: [], knownTerminals: [] }
    });
  });

  it('runs a command through the service', async () => {
    const service = {
      runRemoteCommand: vi.fn(async () => ({ stdout: '/home/deploy\n', exitCode: 0 }))
    };
    const handler = createBridgeRequestHandler({ token: 'secret', service: service as never });

    const response = await call(handler, {
      path: '/tools/run_remote_command',
      token: 'secret',
      body: { serverId: 'server-1', command: ' pwd ', timeoutMs: 1000 }
    });

    expect(service.runRemoteCommand).toHaveBeenCalledWith({
      serverId: 'server-1',
      command: 'pwd',
      timeoutMs: 1000
    });
    expect(response).toMatchObject({
      status: 200,
      body: { stdout: '/home/deploy\n', exitCode: 0 }
    });
  });

  it('routes sftp endpoints through the service', async () => {
    const service = {
      sftpReadFile: vi.fn(async () => ({ content: 'hello' })),
      sftpWriteFile: vi.fn(async () => ({ bytesWritten: 5 }))
    };
    const handler = createBridgeRequestHandler({ token: 'secret', service: service as never });

    await expect(
      call(handler, { path: '/tools/sftp_read_file', token: 'secret', body: { path: '/app.txt' } })
    ).resolves.toEqual({
      status: 200,
      body: { content: 'hello' }
    });
    await expect(
      call(handler, {
        path: '/tools/sftp_write_file',
        token: 'secret',
        body: { path: '/app.txt', content: 'hello' }
      })
    ).resolves.toEqual({
      status: 200,
      body: { bytesWritten: 5 }
    });
    expect(service.sftpReadFile).toHaveBeenCalledWith({ path: '/app.txt' });
    expect(service.sftpWriteFile).toHaveBeenCalledWith({ path: '/app.txt', content: 'hello' });
  });

  it('returns a bridge error when user cancels confirmation', async () => {
    const handler = createBridgeRequestHandler({
      token: 'secret',
      service: {
        runRemoteCommand: async () => {
          throw new Error('Remote command was cancelled.');
        }
      } as never
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
