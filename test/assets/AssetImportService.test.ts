import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from '../../src/assets/AssetPackage';
import { applyAssetImport, type ImportedServerStore } from '../../src/assets/AssetImportService';
import type { ServerConfig } from '../../src/config/schema';

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function payload(servers: ServerConfig[]): AssetPackagePayload {
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: 1,
    source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
    options: { includesPasswords: true, includesPrivateKeys: true, includesHostTrust: false },
    servers,
    passwords: { 'server-1': 'secret' },
    privateKeys: [
      { serverId: 'key-1', originalBasename: 'id_ed25519', contentBase64: Buffer.from('PRIVATE KEY').toString('base64') }
    ],
    omissions: []
  };
}

class MemoryStore implements ImportedServerStore {
  saved: Array<{ server: ServerConfig; password?: string }> = [];

  constructor(public existing: ServerConfig[]) {}

  async listServers(): Promise<ServerConfig[]> {
    return this.existing;
  }

  async saveServer(server: ServerConfig, password?: string): Promise<void> {
    this.saved.push({ server, password });
  }
}

describe('AssetImportService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-import-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('skips conflicting servers and does not import their passwords', async () => {
    const store = new MemoryStore([server()]);
    const summary = await applyAssetImport({
      payload: payload([server()]),
      conflictStrategy: 'skip',
      privateKeyDirectory: dir,
      store,
      generateId: () => 'new-id'
    });

    expect(store.saved).toEqual([]);
    expect(summary).toEqual(expect.objectContaining({ imported: 0, skipped: 1, overwritten: 0, renamed: 0 }));
  });

  it('keeps both conflicting servers with a new id and remaps jump host references', async () => {
    const importedJump = server({ id: 'jump-1', label: 'Jump', host: 'jump.example.com' });
    const importedApp = server({ id: 'app-1', label: 'App', host: 'app.example.com', jumpHostId: 'jump-1' });
    const ids = ['jump-new', 'app-new'];
    const store = new MemoryStore([server({ id: 'jump-1', label: 'Jump', host: 'jump.example.com' })]);

    await applyAssetImport({
      payload: payload([importedJump, importedApp]),
      conflictStrategy: 'rename',
      privateKeyDirectory: dir,
      store,
      generateId: () => ids.shift() ?? 'fallback'
    });

    expect(store.saved.map((entry) => entry.server)).toEqual([
      expect.objectContaining({ id: 'jump-new', label: 'Jump (imported)' }),
      expect.objectContaining({ id: 'app-1', jumpHostId: 'jump-new' })
    ]);
  });

  it('writes imported private keys and rewrites privateKeyPath', async () => {
    const store = new MemoryStore([]);
    await applyAssetImport({
      payload: payload([server({ id: 'key-1', authType: 'privateKey', privateKeyPath: 'old-path' })]),
      conflictStrategy: 'skip',
      privateKeyDirectory: dir,
      store,
      generateId: () => 'new-id'
    });

    expect(store.saved[0].server.privateKeyPath).toContain('id_ed25519');
    await expect(readFile(store.saved[0].server.privateKeyPath!, 'utf8')).resolves.toBe('PRIVATE KEY');
  });
});
