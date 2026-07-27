import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshSession } from '../../src/ssh/SshSession';
import type { ServerConfig } from '../../src/config/schema';

const sshSessionMocks = vi.hoisted(() => ({
  disposeHandle: vi.fn(),
  connect: vi.fn(function (this: { handlers?: Record<string, () => void> }) {
    this.handlers?.ready?.();
  }),
  end: vi.fn()
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: sshSessionMocks.disposeHandle
  }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const shell = new EventEmitter() as EventEmitter & {
      end: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
      setWindow: ReturnType<typeof vi.fn>;
    };
    shell.end = vi.fn();
    shell.write = vi.fn();
    shell.setWindow = vi.fn();
    const client = {
      handlers: {} as Record<string, () => void>,
      once: vi.fn((event: string, handler: () => void) => {
        client.handlers[event] = handler;
        return client;
      }),
      connect: sshSessionMocks.connect,
      end: sshSessionMocks.end,
      shell: vi.fn((_options, _extraOptions, callback) => callback(undefined, shell))
    };
    return client;
  })
}));

function server(): ServerConfig {
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
    updatedAt: 1
  };
}

beforeEach(() => {
  sshSessionMocks.disposeHandle.mockClear();
  sshSessionMocks.connect.mockClear();
  sshSessionMocks.end.mockClear();
});

describe('SshSession host key verification', () => {
  it('tracks connection state as disconnected before connect and after dispose', () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    );

    expect(session.isConnected()).toBe(false);
    session.dispose();
    expect(session.isConnected()).toBe(false);
  });

  it('disposes the SSH connection handle when the session is disposed', async () => {
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: vi.fn() }
    );

    await session.connect();
    session.dispose();

    expect(sshSessionMocks.end).toHaveBeenCalledTimes(1);
    expect(sshSessionMocks.disposeHandle).toHaveBeenCalledTimes(1);
  });
});
