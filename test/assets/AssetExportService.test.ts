import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAssetExportPayload } from '../../src/assets/AssetExportService';
import type { ServerConfig } from '../../src/config/schema';

const passwordServer: ServerConfig = {
  id: 'password-1',
  label: 'Password Server',
  host: 'example.com',
  port: 22,
  username: 'deploy',
  authType: 'password',
  keepAliveInterval: 30,
  encoding: 'utf-8',
  createdAt: 1,
  updatedAt: 1
};

describe('AssetExportService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-export-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports servers and selected passwords/private keys', async () => {
    const keyPath = join(dir, 'id_ed25519');
    await writeFile(keyPath, 'PRIVATE KEY');
    const keyServer: ServerConfig = {
      ...passwordServer,
      id: 'key-1',
      label: 'Key Server',
      authType: 'privateKey',
      privateKeyPath: keyPath
    };

    const payload = await createAssetExportPayload({
      servers: [passwordServer, keyServer],
      includePasswords: true,
      includePrivateKeys: true,
      extensionName: 'at-terminal',
      extensionVersion: '2.10.2',
      getPassword: async (id) => (id === 'password-1' ? 'secret' : undefined),
      now: () => 123
    });

    expect(payload.createdAt).toBe(123);
    expect(payload.passwords).toEqual({ 'password-1': 'secret' });
    expect(payload.privateKeys).toEqual([
      { serverId: 'key-1', originalBasename: 'id_ed25519', contentBase64: Buffer.from('PRIVATE KEY').toString('base64') }
    ]);
    expect(payload.omissions).toEqual([]);
  });

  it('records omissions without inserting empty secret values', async () => {
    const payload = await createAssetExportPayload({
      servers: [
        passwordServer,
        { ...passwordServer, id: 'key-1', authType: 'privateKey', privateKeyPath: join(dir, 'missing.pem') }
      ],
      includePasswords: true,
      includePrivateKeys: true,
      extensionName: 'at-terminal',
      extensionVersion: '2.10.2',
      getPassword: async () => undefined,
      now: () => 123
    });

    expect(payload.passwords).toEqual({});
    expect(payload.privateKeys).toEqual([]);
    expect(payload.omissions).toEqual([
      { serverId: 'password-1', kind: 'password', reason: 'Password was not available in SecretStorage.' },
      { serverId: 'key-1', kind: 'privateKey', reason: 'Private key file could not be read.' }
    ]);
  });
});
