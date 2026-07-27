import { describe, expect, it } from 'vitest';
import { decryptAssetPayload, encryptAssetPayload } from '../../src/assets/AssetCrypto';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from '../../src/assets/AssetPackage';

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
});
