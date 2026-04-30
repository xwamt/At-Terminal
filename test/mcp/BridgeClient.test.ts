import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../../src/mcp/BridgeClient';
import { writeBridgeDiscovery } from '../../src/mcp/BridgeDiscovery';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

const tempRoots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-client-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('BridgeClient', () => {
  it('returns a clear error when extension bridge is not running', async () => {
    const client = new BridgeClient({ home: await tempHome(), fetch: vi.fn() as never });

    await expect(client.listServers()).rejects.toThrow('AT Terminal MCP bridge is not running.');
  });

  it('calls list servers bridge endpoint with token', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, { port: 12345, token: 'secret', pid: 1, updatedAt: 1 });
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ servers: [] })
    }));
    const client = new BridgeClient({ home, fetch: fetch as never });

    await expect(client.listServers()).resolves.toEqual({ servers: [] });
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/tools/list_ssh_servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [BRIDGE_TOKEN_HEADER]: 'secret'
      },
      body: '{}'
    });
  });

  it('calls run command bridge endpoint and returns JSON result', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, { port: 12345, token: 'secret', pid: 1, updatedAt: 1 });
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stdout: 'ok\n', exitCode: 0 })
    }));
    const client = new BridgeClient({ home, fetch: fetch as never });

    await expect(client.runRemoteCommand({ serverId: 'active', command: 'pwd' })).resolves.toEqual({
      stdout: 'ok\n',
      exitCode: 0
    });
  });

  it('surfaces bridge error responses', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, { port: 12345, token: 'secret', pid: 1, updatedAt: 1 });
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'Remote command was cancelled.' })
    }));
    const client = new BridgeClient({ home, fetch: fetch as never });

    await expect(client.runRemoteCommand({ command: 'pwd' })).rejects.toThrow('Remote command was cancelled.');
  });
});
