import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { testSshConnection } from '../../src/ssh/SshConnectionTester';
import { buildSshConnectionHandle } from '../../src/ssh/SshConnectionConfig';

const connect = vi.fn();
const end = vi.fn();
const disposeHandle = vi.fn();
const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connect = connect;
  end = end;
}

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  })
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com', port: 22 },
    dispose: disposeHandle
  }))
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
  connect.mockReset();
  end.mockReset();
  disposeHandle.mockReset();
  clients.length = 0;
  vi.mocked(buildSshConnectionHandle).mockClear();
});

describe('testSshConnection', () => {
  it('resolves when ssh2 reports ready and closes the temporary client', async () => {
    const promise = testSshConnection(server(), { getPassword: async () => 'secret' }, undefined, 5_000);

    await flushPromises();
    clients[0].emit('ready');

    await expect(promise).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledWith({ host: 'example.com', port: 22, readyTimeout: 5_000 });
    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('rejects connection errors and closes the temporary client', async () => {
    const promise = testSshConnection(server(), { getPassword: async () => 'secret' }, undefined, 5_000);
    const error = new Error('Authentication failed');

    await flushPromises();
    clients[0].emit('error', error);

    await expect(promise).rejects.toThrow('Authentication failed');
    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });
});
