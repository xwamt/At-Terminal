import { createCipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decryptAssetPayload, encryptAssetPayload } from '../../src/assets/AssetCrypto';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_UNREADABLE_MESSAGE,
  ASSET_PACKAGE_VERSION,
  type AssetPackageEnvelope,
  type AssetPackagePayload
} from '../../src/assets/AssetPackage';

const scrypt = promisify(scryptCallback);

function payload(): AssetPackagePayload {
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: 1,
    source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
    options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
    servers: [],
    passwords: { 'server-1': 'secret' },
    privateKeys: [],
    omissions: []
  };
}

/**
 * Encrypts arbitrary JSON with the same scrypt/AES-256-GCM parameters the
 * extension uses, bypassing the payload schema, so tests can build envelopes
 * exactly like an older release would have written them.
 */
async function encryptRawJson(value: unknown, packagePassword: string): Promise<AssetPackageEnvelope> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = (await scrypt(packagePassword, salt, 32)) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

describe('AssetCrypto', () => {
  it('round trips encrypted payloads', async () => {
    const envelope = await encryptAssetPayload(payload(), 'package-pass');

    expect(envelope.ciphertext).not.toContain('secret');
    await expect(decryptAssetPayload(envelope, 'package-pass')).resolves.toEqual(payload());
  });

  it('rejects wrong package passwords', async () => {
    const envelope = await encryptAssetPayload(payload(), 'package-pass');

    await expect(decryptAssetPayload(envelope, 'wrong-pass')).rejects.toThrow(
      'Invalid package password or corrupted asset package.'
    );
  });

  it('decrypts packages from 0.3.x whose servers omit the encoding field', async () => {
    const envelope = await encryptRawJson(
      {
        ...payload(),
        source: { extensionName: 'at-terminal', extensionVersion: '0.3.4' },
        servers: [
          {
            id: 'server-1',
            label: 'Legacy',
            host: 'legacy.example.com',
            port: 22,
            username: 'deploy',
            authType: 'password',
            keepAliveInterval: 30,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      },
      'package-pass'
    );

    const decrypted = await decryptAssetPayload(envelope, 'package-pass');

    expect(decrypted.servers).toHaveLength(1);
    expect(decrypted.servers[0].encoding).toBe('utf-8');
  });

  it('reports an unreadable payload instead of a wrong password when the password is right', async () => {
    const envelope = await encryptRawJson({ format: 'something-else-entirely' }, 'package-pass');

    const error = await decryptAssetPayload(envelope, 'package-pass').then(
      () => undefined,
      (reason: unknown) => reason as Error
    );

    expect(error?.message).toBe(ASSET_PACKAGE_UNREADABLE_MESSAGE);
    expect(error?.message).not.toContain('Invalid package password');
  });
});
