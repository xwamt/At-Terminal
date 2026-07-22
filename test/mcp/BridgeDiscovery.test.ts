import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bridgeDiscoveryFile,
  bridgeRegistryEntryFile,
  listBridgeDiscoveries,
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
      id: 'window-a',
      port: 53128,
      token: 'secret-token',
      pid: 123,
      updatedAt: 123456
    });

    await expect(readBridgeDiscovery(home)).resolves.toEqual({
      id: 'window-a',
      port: 53128,
      token: 'secret-token',
      pid: 123,
      updatedAt: 123456
    });
    await expect(readFile(bridgeDiscoveryFile(home), 'utf8')).resolves.toContain('secret-token');
    await expect(readFile(bridgeRegistryEntryFile(home, 'window-a'), 'utf8')).resolves.toContain(
      'window-a'
    );
  });

  it('keeps multiple registry entries and uses legacy file as last-writer snapshot', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'w1',
      port: 1,
      token: 'a',
      pid: 1,
      updatedAt: 1
    });
    await writeBridgeDiscovery(home, {
      id: 'w2',
      port: 2,
      token: 'b',
      pid: 2,
      updatedAt: 2
    });

    const all = await listBridgeDiscoveries(home);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: 1, id: 'w1' }),
        expect.objectContaining({ port: 2, id: 'w2' })
      ])
    );
    await expect(readBridgeDiscovery(home)).resolves.toMatchObject({ port: 2, token: 'b', id: 'w2' });
  });

  it('returns undefined when discovery file is missing or malformed', async () => {
    const home = await tempHome();

    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
    await writeBridgeDiscovery(home, { id: 'x', port: 1, token: 'x', pid: 1, updatedAt: 1 });
    await writeFile(bridgeDiscoveryFile(home), '{bad json', 'utf8');

    await expect(readBridgeDiscovery(home)).resolves.toBeUndefined();
  });

  it('removes only matching owner entry and rewrites legacy snapshot', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'w1',
      port: 53127,
      token: 'old-token',
      pid: 123,
      updatedAt: 1
    });
    await writeBridgeDiscovery(home, {
      id: 'w2',
      port: 53128,
      token: 'new-token',
      pid: 456,
      updatedAt: 2
    });

    await removeBridgeDiscovery(home, { id: 'w1', token: 'old-token', port: 53127, pid: 123 });

    const remaining = await listBridgeDiscoveries(home);
    expect(remaining).toEqual([expect.objectContaining({ id: 'w2', token: 'new-token' })]);
    await expect(readBridgeDiscovery(home)).resolves.toMatchObject({ id: 'w2' });
  });

  it('does not remove discovery metadata owned by a newer bridge instance', async () => {
    const home = await tempHome();
    await writeBridgeDiscovery(home, {
      id: 'w2',
      port: 53128,
      token: 'new-token',
      pid: 456,
      updatedAt: 123456
    });

    await removeBridgeDiscovery(home, { id: 'w1', token: 'old-token', port: 53127, pid: 123 });

    await expect(readBridgeDiscovery(home)).resolves.toMatchObject({
      port: 53128,
      token: 'new-token',
      pid: 456
    });
  });

  it('falls back to legacy single file when registry is empty', async () => {
    const home = await tempHome();
    const legacy = bridgeDiscoveryFile(home);
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(
      legacy,
      JSON.stringify({ port: 9, token: 'legacy', pid: 9, updatedAt: 9 }),
      'utf8'
    );
    await expect(listBridgeDiscoveries(home)).resolves.toEqual([
      { port: 9, token: 'legacy', pid: 9, updatedAt: 9, id: undefined }
    ]);
  });
});

