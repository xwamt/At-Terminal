import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshSession } from '../../src/ssh/SshSession';
import type { ServerConfig } from '../../src/config/schema';

interface FakeShell extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  setWindow: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  shells: [] as FakeShell[]
}));

interface FakeClient extends EventEmitter {
  handlers: Record<string, Array<(...args: never[]) => void>>;
  emit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  shell: ReturnType<typeof vi.fn>;
}

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: vi.fn()
  }))
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const shell = new EventEmitter() as FakeShell;
    shell.end = vi.fn();
    shell.write = vi.fn();
    shell.setWindow = vi.fn();
    shell.pause = vi.fn();
    shell.resume = vi.fn();
    mocks.shells.push(shell);
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
      connect: vi.fn(() => {
        queueMicrotask(() => client.emit('ready'));
      }),
      end: vi.fn(),
      shell: vi.fn((_options, _env, callback: Function) => callback(undefined, shell))
    } as unknown as FakeClient;
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
  mocks.shells.length = 0;
});

describe('SshSession permanent client listeners', () => {
  it('reports a post-connect error through events instead of throwing an uncaught exception', async () => {
    const errors: unknown[] = [];
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status: vi.fn(), error: (error) => errors.push(error) },
      { verify: async () => true }
    );
    await session.connect();

    expect(() => mocks.clients[0].emit('error', new Error('socket reset'))).not.toThrow();
    expect(errors).toHaveLength(1);

    // ssh2 can emit a second error after the first; it must not become an uncaughtException.
    expect(() => mocks.clients[0].emit('error', new Error('connection lost before handshake'))).not.toThrow();
    expect(errors).toHaveLength(2);
  });

  it('marks the session disconnected when the underlying client closes', async () => {
    const status = vi.fn();
    const session = new SshSession(
      server(),
      { getPassword: async () => 'secret' } as never,
      { output: vi.fn(), status, error: vi.fn() },
      { verify: async () => true }
    );
    await session.connect();

    mocks.clients[0].emit('close');

    expect(session.isConnected()).toBe(false);
    expect(status).toHaveBeenLastCalledWith({ state: 'disconnected', text: 'Disconnected' });
  });
});
