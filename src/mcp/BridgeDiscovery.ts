import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BridgeDiscovery } from './BridgeProtocol';

export function bridgeDiscoveryFile(home = homedir()): string {
  return join(home, '.at-terminal', 'mcp-bridge.json');
}

export async function writeBridgeDiscovery(home: string, discovery: BridgeDiscovery): Promise<void> {
  const file = bridgeDiscoveryFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(discovery, null, 2), 'utf8');
}

export async function readBridgeDiscovery(home = homedir()): Promise<BridgeDiscovery | undefined> {
  try {
    const parsed = JSON.parse(await readFile(bridgeDiscoveryFile(home), 'utf8')) as Partial<BridgeDiscovery>;
    if (
      typeof parsed.port === 'number' &&
      Number.isInteger(parsed.port) &&
      parsed.port > 0 &&
      typeof parsed.token === 'string' &&
      parsed.token.length > 0 &&
      typeof parsed.pid === 'number' &&
      typeof parsed.updatedAt === 'number'
    ) {
      return {
        port: parsed.port,
        token: parsed.token,
        pid: parsed.pid,
        updatedAt: parsed.updatedAt
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function removeBridgeDiscovery(home = homedir()): Promise<void> {
  await rm(bridgeDiscoveryFile(home), { force: true });
}
