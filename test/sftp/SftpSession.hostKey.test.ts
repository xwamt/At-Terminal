import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';

const mocks = vi.hoisted(() => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com' },
    dispose: vi.fn()
  }))
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: mocks.buildSshConnectionHandle
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const client = {
      handlers: {} as Record<string, () => void>,
      once: vi.fn((event: string, handler: () => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
        this.handlers?.ready?.();
      }),
      end: vi.fn(),
      sftp: vi.fn((callback: (error: undefined, sftp: { realpath: ReturnType<typeof vi.fn> }) => void) =>
        callback(undefined, { realpath: vi.fn() }))
    };
    return client;
  })
}));

import { SftpSession } from '../../src/sftp/SftpSession';

function server(): ServerConfig {
  return {
    id: 'srv',
    label: 'Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 15,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('SftpSession host key verification', () => {
  beforeEach(() => {
    mocks.buildSshConnectionHandle.mockClear();
  });

  it('passes hostKeyVerifier into buildSshConnectionHandle', async () => {
    const verifier = { verify: vi.fn(async () => true) };
    const passwords = { getPassword: async () => 'secret' };
    const session = new SftpSession(server(), passwords, verifier);

    await session.connect();

    expect(mocks.buildSshConnectionHandle).toHaveBeenCalledWith(server(), passwords, verifier);
  });
});
