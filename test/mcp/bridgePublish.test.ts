import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeServer } from '../../src/mcp/BridgeServer';
import { AT_TERMINAL_PLUGIN_ID } from '../../src/mcp/toolCatalog';

const tempRoots: string[] = [];
const servers: BridgeServer[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'at-terminal-bridge-publish-'));
  tempRoots.push(root);
  return root;
}

function createService(connectedTargets = 0) {
  return {
    listServers: async () => ({ servers: [] }),
    getTerminalContext: vi.fn(async () => ({
      connectedTerminals: Array.from({ length: connectedTargets }, (_, i) => ({
        terminalId: `t${i}`
      })),
      knownTerminals: []
    })),
    runRemoteCommand: vi.fn()
  };
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.dispose();
    }
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('BridgeServer FsBridgePublisher', () => {
  it('publishes registry under ~/.at-series/bridges/<hostApp>/ and removes on dispose', async () => {
    const home = await tempHome();
    const hostApp = 'cursor';
    const server = new BridgeServer({
      service: createService(2) as never,
      home,
      hostApp,
      pluginVersion: '0.3.0'
    });
    servers.push(server);

    await server.start();

    const bridgesDir = join(home, '.at-series', 'bridges', hostApp);
    const files = (await readdir(bridgesDir)).filter((name) => name.endsWith('.json'));
    expect(files).toHaveLength(1);

    const recordPath = join(bridgesDir, files[0]!);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      protocolVersion: number;
      bridgeId: string;
      pluginId: string;
      hostApp: string;
      port: number;
      token: string;
      pid: number;
      updatedAt: number;
      tools: unknown[];
      capabilities?: { connectedTargets?: number };
    };

    expect(record.protocolVersion).toBe(1);
    expect(record.pluginId).toBe(AT_TERMINAL_PLUGIN_ID);
    expect(record.hostApp).toBe(hostApp);
    expect(record.bridgeId).toBe(files[0]!.replace(/\.json$/, ''));
    expect(record.port).toBeGreaterThan(0);
    expect(record.token.length).toBeGreaterThan(0);
    expect(record.pid).toBe(process.pid);
    expect(record.updatedAt).toEqual(expect.any(Number));
    expect(record.tools.length).toBeGreaterThan(0);
    expect(record.capabilities?.connectedTargets).toBe(2);

    await server.dispose();
    servers.pop();

    await expect(access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
