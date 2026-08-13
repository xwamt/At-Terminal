import { request as httpRequest, type ClientRequest } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER, BRIDGE_MAX_BODY_BYTES } from '@at-series/mcp-hub';
import { BridgeServer, createBridgeHttpServer } from '../../src/mcp/BridgeServer';

const tempRoots: string[] = [];
const servers: BridgeServer[] = [];
const requests: ClientRequest[] = [];

interface RunningBridge {
  port: number;
  token: string;
}

async function startBridge(): Promise<RunningBridge> {
  const home = await mkdtemp(join(tmpdir(), 'at-terminal-bridge-http-'));
  tempRoots.push(home);
  const server = new BridgeServer({
    service: {
      listServers: async () => ({ servers: [] }),
      getTerminalContext: async () => ({ connectedTerminals: [], knownTerminals: [] }),
      runRemoteCommand: vi.fn()
    } as never,
    home,
    hostApp: 'cursor',
    pluginVersion: '0.3.0'
  });
  servers.push(server);
  await server.start();

  const bridgesDir = join(home, '.at-series', 'bridges', 'cursor');
  const files = (await readdir(bridgesDir)).filter((name) => name.endsWith('.json'));
  const record = JSON.parse(await readFile(join(bridgesDir, files[0]!), 'utf8')) as {
    port: number;
    token: string;
  };
  return { port: record.port, token: record.token };
}

/**
 * Sends request headers plus a token prefix of the declared body, then stalls. The
 * response therefore can only arrive if the bridge answered without waiting for the
 * rest of the upload.
 */
function postStalledBody(
  port: number,
  declaredBodyBytes: number,
  headers: Record<string, string>
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const clientRequest = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/invoke',
      headers: {
        'content-type': 'application/json',
        'content-length': String(declaredBodyBytes),
        ...headers
      }
    });
    requests.push(clientRequest);
    clientRequest.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    clientRequest.on('error', reject);
    clientRequest.write('{"name":"list_ssh_servers","arguments":{');
  });
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

afterEach(async () => {
  for (const clientRequest of requests.splice(0)) {
    clientRequest.destroy();
  }
  while (servers.length > 0) {
    await servers.pop()?.dispose();
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('bridge HTTP transport', () => {
  it('answers 401 without waiting for an unauthenticated request body', async () => {
    const bridge = await startBridge();

    const status = await withDeadline(
      postStalledBody(bridge.port, BRIDGE_MAX_BODY_BYTES, {}),
      2_000,
      'Bridge buffered an unauthenticated request body instead of rejecting on headers.'
    );

    expect(status).toBe(401);
  });

  it('still buffers and rejects an oversized body once the caller is authenticated', async () => {
    const bridge = await startBridge();
    const oversized = 'x'.repeat(BRIDGE_MAX_BODY_BYTES + 1);

    const status = await withDeadline(
      new Promise<number>((resolve, reject) => {
        const clientRequest = httpRequest({
          host: '127.0.0.1',
          port: bridge.port,
          method: 'POST',
          path: '/invoke',
          headers: {
            'content-type': 'application/json',
            [AT_SERIES_TOKEN_HEADER]: bridge.token
          }
        });
        requests.push(clientRequest);
        clientRequest.on('response', (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        });
        clientRequest.on('error', reject);
        clientRequest.end(oversized);
      }),
      5_000,
      'Bridge never answered an oversized authenticated request.'
    );

    expect(status).toBe(413);
  });

  it('bounds how long a caller may hold a socket open', () => {
    const server = createBridgeHttpServer({
      service: {} as never,
      token: 'secret',
      bridgeId: 'bridge-1',
      hostApp: 'cursor',
      pluginVersion: '0.3.0'
    });

    try {
      expect(server.headersTimeout).toBeGreaterThan(0);
      expect(server.headersTimeout).toBeLessThanOrEqual(30_000);
      expect(server.requestTimeout).toBeGreaterThan(0);
      expect(server.requestTimeout).toBeLessThanOrEqual(60_000);
      expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
    } finally {
      server.close();
    }
  });
});
