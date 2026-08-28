import { describe, expect, it } from 'vitest';
import {
  migrateServerConfig,
  parseServerConfig,
  parseServerConfigList,
  serverConfigSchema
} from '../../src/config/schema';

describe('server config schema', () => {
  it('accepts password auth server configs', () => {
    const parsed = parseServerConfig({
      id: 'server-1',
      label: 'Production',
      group: 'prod',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.host).toBe('example.com');
  });

  it('accepts private key configs with a key path', () => {
    const parsed = serverConfigSchema.parse({
      id: 'server-2',
      label: 'Staging',
      host: 'staging.example.com',
      port: 2222,
      username: 'deploy',
      authType: 'privateKey',
      privateKeyPath: 'C:/Users/alan/.ssh/id_ed25519',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.authType).toBe('privateKey');
  });

  it('accepts agent auth without a private key path', () => {
    const parsed = parseServerConfig({
      id: 'server-3',
      label: 'Agent',
      host: 'agent.example.com',
      port: 22,
      username: 'deploy',
      authType: 'agent',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.authType).toBe('agent');
    expect(parsed.privateKeyPath).toBeUndefined();
  });

  it('rejects an unknown authType', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-3b',
        label: 'Bad Auth',
        host: 'bad.example.com',
        port: 22,
        username: 'root',
        authType: 'kerberos',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('rejects inline jumpHost objects', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-3c',
        label: 'Bad',
        host: 'bad.example.com',
        port: 22,
        username: 'root',
        authType: 'password',
        jumpHost: { host: 'jump.example.com' },
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('accepts an optional jumpHostId reference', () => {
    const parsed = parseServerConfig({
      id: 'server-5',
      label: 'Private API',
      host: '10.0.0.20',
      port: 22,
      username: 'deploy',
      authType: 'password',
      jumpHostId: 'jump-1',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.jumpHostId).toBe('jump-1');
  });

  it('rejects an empty jumpHostId', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-6',
        label: 'Bad Jump',
        host: '10.0.0.21',
        port: 22,
        username: 'deploy',
        authType: 'password',
        jumpHostId: '',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('accepts agent command auto approval when enabled', () => {
    const parsed = parseServerConfig({
      id: 'server-7',
      label: 'Trusted Commands',
      host: 'trusted.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBe(true);
  });

  it('accepts agent command auto approval when disabled', () => {
    const parsed = parseServerConfig({
      id: 'server-8',
      label: 'Manual Commands',
      host: 'manual.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: false,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBe(false);
  });

  it('keeps agent command auto approval optional for existing configs', () => {
    const parsed = parseServerConfig({
      id: 'server-9',
      label: 'Existing',
      host: 'existing.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandAutoApprove).toBeUndefined();
    expect(parsed.agentCommandTrust).toBeUndefined();
  });

  it('accepts the three agent command trust levels', () => {
    const parsed = parseServerConfig({
      id: 'server-13',
      label: 'Full trust',
      host: 'full.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandTrust: 'full',
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.agentCommandTrust).toBe('full');
  });

  it('rejects an unknown agent command trust level', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-14',
        label: 'Bad trust',
        host: 'bad.example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        agentCommandTrust: 'everything',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('keeps background connection disabled for existing configs', () => {
    const parsed = parseServerConfig({
      id: 'server-11',
      label: 'Existing',
      host: 'existing.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.backgroundConnectionAllowed).toBeUndefined();
    expect(parsed.backgroundConnectionAllowed === true).toBe(false);
  });

  it('accepts explicit background connection authorization', () => {
    const parsed = parseServerConfig({
      id: 'server-12',
      label: 'Background enabled',
      host: 'background.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      backgroundConnectionAllowed: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.backgroundConnectionAllowed).toBe(true);
  });

  it('still rejects unrelated unknown fields', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-10',
        label: 'Unknown Field',
        host: 'unknown.example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        agentCommandAutoApprove: true,
        agentTrustEverything: true,
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('accepts gbk and big5 encodings', () => {
    for (const encoding of ['gbk', 'big5'] as const) {
      const parsed = parseServerConfig({
        id: `server-${encoding}`,
        label: `Encoding ${encoding}`,
        host: 'cjk.example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        keepAliveInterval: 30,
        encoding,
        createdAt: 1,
        updatedAt: 2
      });

      expect(parsed.encoding).toBe(encoding);
    }
  });

  it('defaults encoding to utf-8 for configs saved before the field existed', () => {
    const parsed = parseServerConfig({
      id: 'server-15',
      label: 'Legacy',
      host: 'legacy.example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      createdAt: 1,
      updatedAt: 2
    });

    expect(parsed.encoding).toBe('utf-8');
  });

  it('rejects an unsupported encoding', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-16',
        label: 'Bad Encoding',
        host: 'bad.example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        keepAliveInterval: 30,
        encoding: 'latin1',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });

  it('requires privateKeyPath for private key auth', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-4',
        label: 'Missing Key',
        host: 'key.example.com',
        port: 22,
        username: 'deploy',
        authType: 'privateKey',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 2
      })
    ).toThrow();
  });
});

function legacyServer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // A 0.3.x record: no encoding field yet.
  return {
    id: 'legacy-1',
    label: 'Legacy',
    host: 'legacy.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('migrateServerConfig', () => {
  it('defaults encoding to utf-8 when the field is missing', () => {
    expect(migrateServerConfig(legacyServer())?.encoding).toBe('utf-8');
  });

  it('defaults encoding to utf-8 when the stored value is invalid', () => {
    expect(migrateServerConfig(legacyServer({ encoding: 'latin1' }))?.encoding).toBe('utf-8');
  });

  it('strips unknown keys instead of rejecting the record', () => {
    const migrated = migrateServerConfig(legacyServer({ legacyFlag: true, colorTheme: 'dark' }));

    expect(migrated).toBeDefined();
    expect(migrated).not.toHaveProperty('legacyFlag');
    expect(migrated).not.toHaveProperty('colorTheme');
  });

  it('defaults keepAliveInterval to 30 when missing', () => {
    const record = legacyServer();
    delete record.keepAliveInterval;

    expect(migrateServerConfig(record)?.keepAliveInterval).toBe(30);
  });

  it('skips records with an unknown authType', () => {
    expect(migrateServerConfig(legacyServer({ authType: 'kerberos' }))).toBeUndefined();
  });

  it('skips values that are not objects', () => {
    expect(migrateServerConfig('not-a-server')).toBeUndefined();
    expect(migrateServerConfig(null)).toBeUndefined();
    expect(migrateServerConfig([legacyServer()])).toBeUndefined();
  });

  it('keeps all three auth types', () => {
    expect(migrateServerConfig(legacyServer({ authType: 'agent' }))?.authType).toBe('agent');
    expect(
      migrateServerConfig(legacyServer({ authType: 'privateKey', privateKeyPath: '/keys/id_ed25519' }))?.authType
    ).toBe('privateKey');
  });
});

describe('parseServerConfigList', () => {
  it('parses legacy entries without encoding as utf-8', () => {
    const parsed = parseServerConfigList([legacyServer()]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].encoding).toBe('utf-8');
  });

  it('keeps good entries when one entry is invalid', () => {
    const parsed = parseServerConfigList([
      legacyServer({ id: 'good-1' }),
      { totally: 'broken' },
      legacyServer({ id: 'good-2', authType: 'kerberos' }),
      legacyServer({ id: 'good-3' })
    ]);

    expect(parsed.map((server) => server.id)).toEqual(['good-1', 'good-3']);
  });

  it('returns an empty list for non-array input', () => {
    expect(parseServerConfigList(undefined)).toEqual([]);
    expect(parseServerConfigList({ servers: [] })).toEqual([]);
  });
});
