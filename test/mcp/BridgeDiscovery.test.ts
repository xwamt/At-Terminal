import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeDiscoveryFile,
  readBridgeDiscovery,
  removeBridgeDiscovery,
  writeBridgeDiscovery
} from '../../src/mcp/BridgeDiscovery';

const tempRoots: string[] = [];

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('BridgeDiscovery', () => {
  it('uses a stable user-local discovery path', async () => {
    const home = await tempHome();

    expect(bridgeDiscoveryFile(home)).toBe(join(home, '.at-terminal', 'mcp-bridge.json'));
  });

  it('writes and reads bridge discovery metadata', async () => {
    const home = await tempHome();

    await writeBridgeDiscovery(home, {
      port: 53128,
      token: 'secret-token',
      pid: 123,
      updatedAt: 123456
    });

    await expect(readBridgeDiscovery(home)).resolves.toEqual({
      port: 53128,
      token: 'secret-token',
      pid: 123,
      updatedAt: 123456
    });
    await expect(readFile(bridgeDiscoveryFile(home), 'utf8')).resolves.toContain('secret-token');
  });

  it('returns undefined when discovery file is missing or malformed', async () => {
    const home = await tempHome();

    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
    await writeFile(bridgeDiscoveryFile(home), '{bad json', 'utf8').catch(async () => {
      await writeBridgeDiscovery(home, { port: 1, token: 'x', pid: 1, updatedAt: 1 });
      await writeFile(bridgeDiscoveryFile(home), '{bad json', 'utf8');
    });

    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('removes stale discovery file', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      port: 53128,
      token: 'secret-token',
      pid: 123,
      updatedAt: 123456
    });

    await removeBridgeDiscovery(home);

    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });
});
