import { describe, expect, it, vi } from 'vitest';
import { SftpWriteAuthorizer } from '../../src/agent/SftpWriteAuthorizer';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('SftpWriteAuthorizer', () => {
  it('prompts only once per server when approved', async () => {
    const confirm = vi.fn(async () => true);
    const authorizer = new SftpWriteAuthorizer(confirm);

    await expect(
      authorizer.requireWrite(server(), { operation: 'write_file', path: '/app/a.txt', overwrite: true })
    ).resolves.toBeUndefined();
    await expect(
      authorizer.requireWrite(server(), { operation: 'create_file', path: '/app/b.txt', overwrite: false })
    ).resolves.toBeUndefined();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(server(), {
      operation: 'write_file',
      path: '/app/a.txt',
      overwrite: true
    });
  });

  it('throws when user cancels authorization', async () => {
    const authorizer = new SftpWriteAuthorizer(async () => false);

    await expect(
      authorizer.requireWrite(server(), {
        operation: 'write_file',
        path: '/app/a.txt',
        overwrite: false
      })
    ).rejects.toThrow('SFTP write was cancelled.');
  });
});
