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
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
        options: { includesPasswords: true, includesPrivateKeys: true, includesHostTrust: false },
        servers: [
          {
            id: 'server-1',
            label: 'Prod',
            host: 'example.com',
            port: 22,
            username: 'deploy',
            authType: 'password',
            backgroundConnectionAllowed: true,
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
    ).toEqual([
      expect.objectContaining({
        id: 'server-1',
        backgroundConnectionAllowed: true
      })
    ]);
  });

  it('migrates payload servers exported before the encoding field existed', () => {
    const parsed = parseAssetPackagePayload({
      format: ASSET_PACKAGE_FORMAT,
      version: ASSET_PACKAGE_VERSION,
      createdAt: 1,
      source: { extensionName: 'at-terminal', extensionVersion: '0.3.4' },
      options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
      servers: [
        {
          id: 'server-1',
          label: 'Legacy',
          host: 'legacy.example.com',
          port: 22,
          username: 'deploy',
          authType: 'password',
          keepAliveInterval: 30,
          legacyColor: 'green',
          createdAt: 1,
          updatedAt: 1
        }
      ],
      passwords: { 'server-1': 'secret' },
      privateKeys: [],
      omissions: []
    });

    expect(parsed.servers).toHaveLength(1);
    expect(parsed.servers[0].encoding).toBe('utf-8');
    expect(parsed.servers[0]).not.toHaveProperty('legacyColor');
  });

  it('drops unmigratable server entries instead of failing the whole payload', () => {
    const parsed = parseAssetPackagePayload({
      format: ASSET_PACKAGE_FORMAT,
      version: ASSET_PACKAGE_VERSION,
      createdAt: 1,
      source: { extensionName: 'at-terminal', extensionVersion: '0.3.4' },
      options: { includesPasswords: false, includesPrivateKeys: false, includesHostTrust: false },
      servers: [
        { broken: true },
        {
          id: 'server-2',
          label: 'Good',
          host: 'good.example.com',
          port: 22,
          username: 'deploy',
          authType: 'password',
          keepAliveInterval: 30,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      passwords: {},
      privateKeys: [],
      omissions: []
    });

    expect(parsed.servers.map((server) => server.id)).toEqual(['server-2']);
  });

  it('rejects host trust exports in v1 payloads', () => {
    expect(() =>
      parseAssetPackagePayload({
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
        options: { includesPasswords: false, includesPrivateKeys: false, includesHostTrust: true },
        servers: [],
        passwords: {},
        privateKeys: [],
        omissions: []
      })
    ).toThrow();
  });
});
