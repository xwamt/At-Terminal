import { describe, expect, it } from 'vitest';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_VERSION,
  parseAssetPackageEnvelope,
  parseAssetPackagePayload
} from '../../src/assets/AssetPackage';

describe('AssetPackage', () => {
  it('parses a valid encrypted package envelope', () => {
    expect(
      parseAssetPackageEnvelope({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm',
        salt: 'c2FsdA==',
        iv: 'aXY=',
        authTag: 'dGFn',
        ciphertext: 'Y2lwaGVydGV4dA=='
      })
    ).toEqual(
      expect.objectContaining({
        format: 'at-terminal-assets',
        version: 1,
        kdf: 'scrypt',
        cipher: 'aes-256-gcm'
      })
    );
  });

  it('parses a valid decrypted payload', () => {
    expect(
      parseAssetPackagePayload({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
        options: { includesPasswords: true, includesPrivateKeys: true, includesHostTrust: false },
        servers: [
          {
            id: 'server-1',
            label: 'Prod',
            host: 'example.com',
            port: 22,
            username: 'deploy',
            authType: 'password',
            keepAliveInterval: 30,
            encoding: 'utf-8',
            createdAt: 1,
            updatedAt: 1
          }
        ],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      }).servers
    ).toHaveLength(1);
  });

  it('rejects host trust exports in v1 payloads', () => {
    expect(() =>
      parseAssetPackagePayload({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.1' },
        options: { includesPasswords: false, includesPrivateKeys: false, includesHostTrust: true },
        servers: [],
        passwords: {},
        privateKeys: [],
        omissions: []
      })
    ).toThrow();
  });
});
