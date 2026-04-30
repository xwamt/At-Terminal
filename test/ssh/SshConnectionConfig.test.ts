import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { buildSshConnectConfig } from '../../src/ssh/SshConnectionConfig';
import type { ServerConfig } from '../../src/config/schema';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}));

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
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

describe('buildSshConnectConfig', () => {
  it('builds password auth config with keepalive and host verifier', async () => {
    const verifier = { verify: vi.fn(async () => true) };

    const config = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      verifier
    );

    expect(config).toMatchObject({
      host: 'example.com',
      port: 22,
      username: 'deploy',
      password: 'secret',
      keepaliveInterval: 30_000,
      hostHash: 'sha256'
    });
    expect(config.hostVerifier).toEqual(expect.any(Function));
  });

  it('throws a clear error when password auth has no stored password', async () => {
    await expect(
      buildSshConnectConfig(server(), { getPassword: async () => undefined })
    ).rejects.toThrow('Missing password. Edit the server configuration and enter a password.');
  });

  it('loads private key auth from disk', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('PRIVATE KEY');

    const config = await buildSshConnectConfig(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      { getPassword: async () => undefined }
    );

    expect(readFile).toHaveBeenCalledWith('C:/keys/prod.pem', 'utf8');
    expect(config).toMatchObject({
      privateKey: 'PRIVATE KEY'
    });
    expect('password' in config).toBe(false);
  });

  it('throws a clear error when private key auth has no key path', async () => {
    await expect(
      buildSshConnectConfig(
        server({ authType: 'privateKey', privateKeyPath: undefined }),
        { getPassword: async () => undefined }
      )
    ).rejects.toThrow('Missing private key path.');
  });

  it('waits for async host key verification callback instead of accepting synchronously', async () => {
    let resolveVerification: (value: boolean) => void = () => undefined;
    const verifier = {
      verify: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveVerification = resolve;
          })
      )
    };

    const config = await buildSshConnectConfig(
      server(),
      { getPassword: async () => 'secret' },
      verifier
    );
    const verify = vi.fn();

    const result = config.hostVerifier!('SHA256:abc' as never, verify);

    expect(result).toBeUndefined();
    expect(verify).not.toHaveBeenCalled();
    resolveVerification(false);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledWith(false));
    expect(verifier.verify).toHaveBeenCalledWith('example.com', 22, 'SHA256:abc');
  });
});
