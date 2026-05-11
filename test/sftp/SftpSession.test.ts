import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildSftpConnectConfig } from '../../src/sftp/SftpSession';
import { SftpSession } from '../../src/sftp/SftpSession';
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

describe('SftpSession uploadFile sudo fallback', () => {
  it('uploads to /tmp and uses sudo when direct upload is permission denied', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    let sudoCommand = '';
    const client = {
      exec: vi.fn((command: string, callback) => {
        sudoCommand = command;
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => stream.emit('close', 0));
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await session.uploadFile('C:/tmp/app.conf', '/etc/app.conf');

    expect(fastPut).toHaveBeenCalledTimes(2);
    expect(fastPut.mock.calls[0][1]).toBe('/etc/app.conf');
    expect(fastPut.mock.calls[1][1]).toMatch(/^\/tmp\/at-terminal-upload-.+-app\.conf$/);
    expect(sudoCommand).toContain('sudo -n sh -c');
    expect(sudoCommand).toContain('/etc/app.conf');
    expect(sudoCommand).toContain(fastPut.mock.calls[1][1]);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('reports sudo fallback stderr when elevated upload also fails', async () => {
    const permissionDenied = new Error('Permission denied') as Error & { code: number };
    permissionDenied.code = 3;
    const fastPut = vi
      .fn()
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback(permissionDenied))
      .mockImplementationOnce((_localPath, _remotePath, _options, callback) => callback());
    const unlink = vi.fn((_remotePath, callback) => callback());
    const client = {
      exec: vi.fn((_command: string, callback) => {
        const stream = new FakeExecStream();
        callback(undefined, stream);
        queueMicrotask(() => {
          stream.stderr.emit('data', Buffer.from('sudo: a password is required\n'));
          stream.emit('close', 1);
        });
      })
    };
    const session = new SftpSession(server('password'), { getPassword: async () => 'secret' });
    (session as unknown as { sftp: unknown; client: unknown }).sftp = { fastPut, unlink };
    (session as unknown as { sftp: unknown; client: unknown }).client = client;

    await expect(session.uploadFile('C:/tmp/app.conf', '/etc/app.conf')).rejects.toThrow(
      'sudo: a password is required'
    );
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/at-terminal-upload-.+-app\.conf$/), expect.any(Function));
  });
});

class FakeExecStream extends EventEmitter {
  readonly stderr = new EventEmitter();
}
