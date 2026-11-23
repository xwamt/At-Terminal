import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SftpSession } from '../../src/sftp/SftpSession';
import type { ServerConfig } from '../../src/config/schema';

interface FakeSftp extends EventEmitter {
  realpath: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    handlers: Record<string, Array<(...args: never[]) => void>>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    sftp: ReturnType<typeof vi.fn>;
  }>,
  wrappers: [] as FakeSftp[],
  disposeHandle: vi.fn()
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: mocks.disposeHandle
  }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const wrapper = new EventEmitter() as FakeSftp;
    wrapper.realpath = vi.fn();
    wrapper.stat = vi.fn();
    wrapper.end = vi.fn();
    mocks.wrappers.push(wrapper);
    const handlers: Record<string, Array<(...args: never[]) => void>> = {};
    const client = {
      handlers,
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        (handlers[event] ??= []).push(handler);
        return client;
      }),
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        (handlers[event] ??= []).push(handler);
        return client;
      }),
      emit: vi.fn((event: string, ...args: never[]) => {
        for (const handler of handlers[event] ?? []) {
          handler(...args);
        }
        return true;
      }),
      connect: vi.fn(() => queueMicrotask(() => client.emit('ready'))),
      end: vi.fn(),
      sftp: vi.fn((callback: Function) => callback(undefined, wrapper))
    };
    mocks.clients.push(client);
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
  mocks.clients.length = 0;
  mocks.wrappers.length = 0;
  mocks.disposeHandle.mockClear();
});

describe('SftpSession connection drop handling', () => {
  it('becomes disconnected and notifies the pool when the SSH client closes', async () => {
    const onDisconnected = vi.fn();
    const session = new SftpSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { verify: async () => true },
      { allowSudoFallback: true, onDisconnected }
    );
    await session.connect();
    expect(session.isConnected()).toBe(true);

    mocks.clients[0].emit('close');

    expect(session.isConnected()).toBe(false);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(mocks.disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('becomes disconnected when the SFTP subsystem closes', async () => {
    const onDisconnected = vi.fn();
    const session = new SftpSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { verify: async () => true },
      { allowSudoFallback: true, onDisconnected }
    );
    await session.connect();

    mocks.wrappers[0].emit('end');

    expect(session.isConnected()).toBe(false);
    expect(onDisconnected).toHaveBeenCalledTimes(1);
  });

  it('does not report a drop for an intentional dispose', async () => {
    const onDisconnected = vi.fn();
    const session = new SftpSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { verify: async () => true },
      { allowSudoFallback: true, onDisconnected }
    );
    await session.connect();

    session.dispose();

    expect(session.isConnected()).toBe(false);
    expect(onDisconnected).not.toHaveBeenCalled();
  });
});
