import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeDiscovery } from './BridgeProtocol';

export interface RemoveBridgeDiscoveryOwner {
  id?: string;
  port: number;
  token: string;
  pid: number;
}

export function bridgeDiscoveryFile(home = homedir()): string {
  return join(home, '.at-terminal', 'mcp-bridge.json');
}

export function bridgeRegistryDirectory(home = homedir()): string {
  return join(home, '.at-terminal', 'mcp-bridges');
}

export function bridgeRegistryEntryFile(home: string, id: string): string {
  return join(bridgeRegistryDirectory(home), `${id}.json`);
}

function isValidDiscovery(parsed: Partial<BridgeDiscovery>): parsed is BridgeDiscovery {
  return (
    typeof parsed.port === 'number' &&
    Number.isInteger(parsed.port) &&
    parsed.port > 0 &&
    typeof parsed.token === 'string' &&
    parsed.token.length > 0 &&
    typeof parsed.pid === 'number' &&
    typeof parsed.updatedAt === 'number'
  );
}

function normalizeDiscovery(parsed: Partial<BridgeDiscovery>): BridgeDiscovery | undefined {
  if (!isValidDiscovery(parsed)) {
    return undefined;
  }
  return {
    id: typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : undefined,
    port: parsed.port,
    token: parsed.token,
    pid: parsed.pid,
    updatedAt: parsed.updatedAt
  };
}

export async function writeBridgeDiscovery(home: string, discovery: BridgeDiscovery): Promise<void> {
  const id = discovery.id;
  if (!id) {
    throw new Error('Bridge discovery id is required.');
  }
  const record: BridgeDiscovery = {
    id,
    port: discovery.port,
    token: discovery.token,
    pid: discovery.pid,
    updatedAt: discovery.updatedAt
  };
  const registryDir = bridgeRegistryDirectory(home);
  await mkdir(registryDir, { recursive: true });
  await writeFile(bridgeRegistryEntryFile(home, id), JSON.stringify(record, null, 2), 'utf8');
  await mkdir(dirname(bridgeDiscoveryFile(home)), { recursive: true });
  await writeFile(bridgeDiscoveryFile(home), JSON.stringify(record, null, 2), 'utf8');
}

export async function readBridgeDiscovery(home = homedir()): Promise<BridgeDiscovery | undefined> {
  try {
    const parsed = JSON.parse(await readFile(bridgeDiscoveryFile(home), 'utf8')) as Partial<BridgeDiscovery>;
    return normalizeDiscovery(parsed);
  } catch {
    return undefined;
  }
}

export async function listBridgeDiscoveries(home = homedir()): Promise<BridgeDiscovery[]> {
  const byKey = new Map<string, BridgeDiscovery>();

  try {
    const files = await readdir(bridgeRegistryDirectory(home));
    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      try {
        const parsed = JSON.parse(
          await readFile(join(bridgeRegistryDirectory(home), file), 'utf8')
        ) as Partial<BridgeDiscovery>;
        const discovery = normalizeDiscovery(parsed);
        if (!discovery) {
          continue;
        }
        const key = discovery.id ?? `${discovery.port}:${discovery.token}:${discovery.pid}`;
        byKey.set(key, discovery);
      } catch {
        // skip corrupt entry
      }
    }
  } catch {
    // registry directory may not exist yet
  }

  if (byKey.size === 0) {
    const legacy = await readBridgeDiscovery(home);
    if (legacy) {
      return [legacy];
    }
    return [];
  }

  return Array.from(byKey.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function removeBridgeDiscovery(home = homedir(), owner?: RemoveBridgeDiscoveryOwner): Promise<void> {
  if (!owner) {
    await rm(bridgeDiscoveryFile(home), { force: true });
    await rm(bridgeRegistryDirectory(home), { recursive: true, force: true });
    return;
  }

  if (owner.id) {
    await rm(bridgeRegistryEntryFile(home, owner.id), { force: true });
  } else {
    const entries = await listBridgeDiscoveries(home);
    for (const entry of entries) {
      if (entry.port === owner.port && entry.token === owner.token && entry.pid === owner.pid && entry.id) {
        await rm(bridgeRegistryEntryFile(home, entry.id), { force: true });
      }
    }
  }

  const legacy = await readBridgeDiscovery(home);
  if (
    legacy &&
    legacy.port === owner.port &&
    legacy.token === owner.token &&
    legacy.pid === owner.pid &&
    (owner.id === undefined || legacy.id === owner.id || legacy.id === undefined)
  ) {
    const remaining = (await listBridgeDiscoveries(home)).filter(
      (entry) => !(entry.port === owner.port && entry.token === owner.token && entry.pid === owner.pid)
    );
    if (remaining[0]) {
      await writeFile(bridgeDiscoveryFile(home), JSON.stringify(remaining[0], null, 2), 'utf8');
    } else {
      await rm(bridgeDiscoveryFile(home), { force: true });
    }
  }
}
