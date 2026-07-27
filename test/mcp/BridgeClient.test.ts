import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeClient } from '../../src/mcp/BridgeClient';
import { writeBridgeDiscovery } from '../../src/mcp/BridgeDiscovery';
import { BRIDGE_TOKEN_HEADER } from '../../src/mcp/BridgeProtocol';

const tempRoots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'at-terminal-client-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function createFetchRouter(
  routes: Record<string, (init: { headers: Record<string, string>; body: string }) => unknown>
) {
  return vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        const result = handler(init);
        if (result && typeof result === 'object' && 'ok' in (result as object)) {
          return result;
        }
        return jsonResponse(200, result);
      }
    }
    return jsonResponse(404, { error: `no route for ${url}` });
  });
}

describe('BridgeClient', () => {
  it('returns a clear error when extension bridge is not running', async () => {
    const client = new BridgeClient({ home: await tempHome(), fetch: vi.fn() as never });
    await expect(client.listServers()).rejects.toThrow('AT Terminal MCP bridge is not running.');
  });

  it('calls list servers bridge endpoint with token', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] }),
      '/tools/list_ssh_servers': (init) => {
        expect(init.headers[BRIDGE_TOKEN_HEADER]).toBe('secret');
        return { servers: [] };
      }
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).resolves.toEqual({ servers: [] });
  });

  it('calls run command bridge endpoint and returns JSON result', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] }),
      '/tools/run_remote_command': () => ({ stdout: 'ok', exitCode: 0 })
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.runRemoteCommand({ command: 'pwd' })).resolves.toEqual({
      stdout: 'ok',
      exitCode: 0
    });
  });

  it('calls terminal context bridge endpoint', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] })
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.getTerminalContext()).resolves.toEqual({
      connectedTerminals: [],
      knownTerminals: []
    });
  });

  it('calls sftp read and write bridge endpoints', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] }),
      '/tools/sftp_read_file': () => ({ content: 'x' }),
      '/tools/sftp_write_file': () => ({ bytesWritten: 1 })
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.sftpReadFile({ path: '/a' })).resolves.toEqual({ content: 'x' });
    await expect(client.sftpWriteFile({ path: '/a', content: 'x' })).resolves.toEqual({
      bytesWritten: 1
    });
  });

  it('surfaces bridge error responses', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] }),
      '/tools/list_ssh_servers': () => jsonResponse(500, { error: 'boom' })
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).rejects.toThrow('boom');
  });

  it('turns unreachable stale bridge discovery into a clear bridge error', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).rejects.toThrow(
      'AT Terminal MCP bridge is not reachable. Reload VS Code with AT Terminal running, then retry.'
    );
  });

  it('retries with refreshed bridge discovery after the previous VS Code bridge is unreachable', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'stale',
      port: 12345,
      token: 'stale-token',
      pid: 1,
      updatedAt: 1
    });
    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const token = init.headers[BRIDGE_TOKEN_HEADER];
      if (token === 'stale-token') {
        await writeBridgeDiscovery(home, {
          id: 'fresh',
          port: 23456,
          token: 'fresh-token',
          pid: 2,
          updatedAt: 2
        });
        throw new Error('stale down');
      }
      if (url.includes('/health')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.includes('/tools/get_terminal_context')) {
        return jsonResponse(200, { connectedTerminals: [], knownTerminals: [] });
      }
      if (url.includes('/tools/list_ssh_servers')) {
        expect(token).toBe('fresh-token');
        return jsonResponse(200, { servers: [] });
      }
      return jsonResponse(404, { error: 'missing' });
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).resolves.toEqual({ servers: [] });
  });

  it('reports non-json bridge responses without masking the HTTP status', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'bridge-1',
      port: 12345,
      token: 'secret',
      pid: 1,
      updatedAt: 1
    });
    const fetch = createFetchRouter({
      '/health': () => ({ ok: true }),
      '/tools/get_terminal_context': () => ({ connectedTerminals: [], knownTerminals: [] }),
      '/tools/list_ssh_servers': () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        }
      })
    });
    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).rejects.toThrow('Bridge request failed with HTTP 502.');
  });

  it('prefers a healthy bridge whose terminal context has connected terminals', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'empty',
      port: 10001,
      token: 't1',
      pid: 1,
      updatedAt: 1
    });
    await writeBridgeDiscovery(home, {
      id: 'busy',
      port: 10002,
      token: 't2',
      pid: 2,
      updatedAt: 2
    });

    const fetch = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const token = init.headers[BRIDGE_TOKEN_HEADER];
      if (url.includes('/health')) {
        return jsonResponse(200, { ok: true });
      }
      if (url.includes('/tools/get_terminal_context')) {
        if (token === 't1') {
          return jsonResponse(200, { connectedTerminals: [], knownTerminals: [] });
        }
        return jsonResponse(200, {
          connectedTerminals: [{ terminalId: 'term-1', connected: true }],
          knownTerminals: []
        });
      }
      if (url.includes('/tools/list_ssh_servers')) {
        expect(token).toBe('t2');
        return jsonResponse(200, { servers: [{ id: 'from-busy' }] });
      }
      return jsonResponse(404, { error: 'nope' });
    });

    const client = new BridgeClient({ home, fetch: fetch as never });
    await expect(client.listServers()).resolves.toEqual({ servers: [{ id: 'from-busy' }] });
  });
});
