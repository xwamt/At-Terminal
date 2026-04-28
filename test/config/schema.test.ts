import { describe, expect, it } from 'vitest';
import { parseServerConfig, serverConfigSchema } from '../../src/config/schema';

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

  it('rejects agent auth and jumpHost fields', () => {
    expect(() =>
      parseServerConfig({
        id: 'server-3',
        label: 'Bad',
        host: 'bad.example.com',
        port: 22,
        username: 'root',
        authType: 'agent',
        jumpHost: { host: 'jump.example.com' },
        keepAliveInterval: 30,
        encoding: 'utf-8',
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
