import { describe, expect, it } from 'vitest';
import { buildSftpConnectConfig } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

function server(authType: 'password' | 'privateKey'): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    authType,
    privateKeyPath: authType === 'privateKey' ? 'C:/keys/id_rsa' : undefined,
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('buildSftpConnectConfig', () => {
  it('uses the stored password for password auth', async () => {
    const config = await buildSftpConnectConfig(server('password'), {
      getPassword: async () => 'secret'
    });

    expect(config).toMatchObject({
      host: 'example.com',
      port: 2222,
      username: 'deploy',
      password: 'secret',
      keepaliveInterval: 15000
    });
  });

  it('rejects missing passwords', async () => {
    await expect(
      buildSftpConnectConfig(server('password'), {
        getPassword: async () => undefined
      })
    ).rejects.toThrow('Missing password');
  });
});
