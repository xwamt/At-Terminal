import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import {
  buildSshConnectionHandle,
  disposeJumpHostConnections
} from '../../src/ssh/SshConnectionConfig';

interface FakeClient {
  handlers: Record<string, Array<(...args: never[]) => void>>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  forwardOut: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  end: vi.fn(),
  forwardOut: vi.fn(),
  connect: vi.fn()
}));

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const client: FakeClient = {
      handlers: {},
      on: vi.fn((event: string, handler: (...args: never[]) => void) => {
        (client.handlers[event] ??= []).push(handler);
        return client;
      }),
      once: vi.fn((event: string, handler: (...args: never[]) => void) => {
        (client.handlers[event] ??= []).push(handler);
        return client;
      }),
      connect: mocks.connect,
      end: mocks.end,
      forwardOut: mocks.forwardOut
    };
    mocks.clients.push(client);
    return client;
  })
}));

function server(overrides: Partial<ServerConfig>): ServerConfig {
  return {
    id: 'server-1',
    label: 'Server',
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

beforeEach(() => {
  disposeJumpHostConnections();
  mocks.clients.length = 0;
  mocks.end.mockReset();
  mocks.forwardOut.mockReset();
  mocks.connect.mockReset();
  mocks.connect.mockImplementation(function (this: FakeClient) {
    for (const handler of this.handlers.ready ?? []) {
      handler();
    }
  });
});

describe('JumpHostPool', () => {
  it('shares one jump-host client across concurrent target connections', async () => {
    mocks.forwardOut.mockImplementation((_srcIp, _srcPort, _dstHost, _dstPort, callback) =>
      callback(undefined, { readable: true })
    );
    const jump = server({ id: 'jump-1', host: 'bastion.example.com' });
    const targetA = server({ id: 'target-a', host: '10.0.0.10', jumpHostId: 'jump-1' });
    const targetB = server({ id: 'target-b', host: '10.0.0.11', jumpHostId: 'jump-1' });
    const provider = {
      getPassword: async () => 'secret',
      getServer: async (id: string) => (id === 'jump-1' ? jump : undefined)
    };

    const [first, second] = await Promise.all([
      buildSshConnectionHandle(targetA, provider, { verify: async () => true }),
      buildSshConnectionHandle(targetB, provider, { verify: async () => true })
    ]);

    expect(mocks.clients).toHaveLength(1);
    expect(mocks.forwardOut).toHaveBeenCalledTimes(2);
    first.dispose();
    second.dispose();
    disposeJumpHostConnections('jump-1');
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it('supports a two-level jump chain A -> B -> C', async () => {
    mocks.forwardOut.mockImplementation((_srcIp, _srcPort, _dstHost, _dstPort, callback) =>
      callback(undefined, { readable: true })
    );
    const hostC = server({ id: 'jump-c', host: 'c.example.com' });
    const hostB = server({ id: 'jump-b', host: 'b.example.com', jumpHostId: 'jump-c' });
    const targetA = server({ id: 'target-a', host: '10.0.0.10', jumpHostId: 'jump-b' });
    const servers = new Map([
      [hostC.id, hostC],
      [hostB.id, hostB]
    ]);
    const provider = {
      getPassword: async () => 'secret',
      getServer: async (id: string) => servers.get(id)
    };

    const handle = await buildSshConnectionHandle(targetA, provider, { verify: async () => true });

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.forwardOut).toHaveBeenNthCalledWith(1, '127.0.0.1', 0, 'b.example.com', 22, expect.any(Function));
    expect(mocks.forwardOut).toHaveBeenNthCalledWith(2, '127.0.0.1', 0, '10.0.0.10', 22, expect.any(Function));
    handle.dispose();
    disposeJumpHostConnections();
  });


  it('evicts a cached jump client that closes on its own before the idle TTL', async () => {
    mocks.forwardOut.mockImplementation((_srcIp, _srcPort, _dstHost, _dstPort, callback) =>
      callback(undefined, { readable: true })
    );
    const jump = server({ id: 'jump-1', host: 'bastion.example.com' });
    const provider = {
      getPassword: async () => 'secret',
      getServer: async (id: string) => (id === 'jump-1' ? jump : undefined)
    };

    const first = await buildSshConnectionHandle(
      server({ id: 'target-a', jumpHostId: 'jump-1' }),
      provider,
      { verify: async () => true }
    );
    expect(mocks.clients).toHaveLength(1);
    for (const handler of mocks.clients[0].handlers.close ?? []) {
      handler();
    }
    expect(mocks.end).toHaveBeenCalledTimes(1);

    const second = await buildSshConnectionHandle(
      server({ id: 'target-b', jumpHostId: 'jump-1' }),
      provider,
      { verify: async () => true }
    );
    expect(mocks.clients).toHaveLength(2);
    first.dispose();
    second.dispose();
    disposeJumpHostConnections('jump-1');
  });

  it('rejects a circular jump chain with the full path', async () => {
    const hostA = server({ id: 'a', host: 'a.example.com', jumpHostId: 'b' });
    const hostB = server({ id: 'b', host: 'b.example.com', jumpHostId: 'a' });
    const servers = new Map([
      ['a', hostA],
      ['b', hostB]
    ]);
    const provider = {
      getPassword: async () => 'secret',
      getServer: async (id: string) => servers.get(id)
    };

    await expect(
      buildSshConnectionHandle(server({ id: 'target', jumpHostId: 'a' }), provider, {
        verify: async () => true
      })
    ).rejects.toThrow('Circular jump host chain detected: target -> a -> b -> a.');
  });

  it('swallows a second error from a jump client instead of crashing the process', async () => {
    mocks.forwardOut.mockImplementation((_srcIp, _srcPort, _dstHost, _dstPort, callback) =>
      callback(undefined, { readable: true })
    );
    const jump = server({ id: 'jump-1', host: 'bastion.example.com' });
    const provider = {
      getPassword: async () => 'secret',
      getServer: async (id: string) => (id === 'jump-1' ? jump : undefined)
    };

    const handle = await buildSshConnectionHandle(
      server({ id: 'target', jumpHostId: 'jump-1' }),
      provider,
      { verify: async () => true }
    );

    const jumpClient = mocks.clients[0];
    expect(() => {
      for (const handler of jumpClient.handlers.error ?? []) {
        handler(new Error('Connection lost before handshake') as never);
      }
    }).not.toThrow();
    handle.dispose();
    disposeJumpHostConnections('jump-1');
  });
});
