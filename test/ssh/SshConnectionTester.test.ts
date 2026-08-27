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

/**
 * The tester loads ssh2 through the async ssh2Loader, so the fake client appears a few
 * microtasks after testSshConnection is called; poll for it instead of counting ticks.
 */
async function waitForClient(): Promise<FakeClient> {
  await vi.waitFor(() => {
    expect(clients.length).toBeGreaterThan(0);
  });
  return clients[0];
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
    const promise = testSshConnection(server(), { getPassword: async () => 'secret' }, { verify: async () => true }, 5_000);

    const client = await waitForClient();
    client.emit('ready');

    await expect(promise).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledWith({ host: 'example.com', port: 22, readyTimeout: 5_000 });
    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('rejects connection errors and closes the temporary client', async () => {
    const promise = testSshConnection(server(), { getPassword: async () => 'secret' }, { verify: async () => true }, 5_000);
    const error = new Error('Authentication failed');

    const client = await waitForClient();
    client.emit('error', error);

    await expect(promise).rejects.toThrow('Authentication failed');
    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('answers keyboard-interactive rounds through the injected prompt', async () => {
    const prompt = vi.fn(async () => ['123456']);
    const promise = testSshConnection(
      server(),
      { getPassword: async () => 'secret' },
      { verify: async () => true },
      5_000,
      prompt
    );

    const client = await waitForClient();
    client.emit(
      'keyboard-interactive',
      '2FA',
      '',
      'en',
      [{ prompt: 'Verification code:', echo: false }],
      (responses: string[]) => {
        expect(responses).toEqual(['123456']);
        client.emit('ready');
      }
    );

    await expect(promise).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledWith({
      name: '2FA',
      instructions: '',
      prompts: [{ prompt: 'Verification code:', echo: false }]
    });
  });

  it('rejects a cancelled keyboard-interactive prompt instead of hanging', async () => {
    const promise = testSshConnection(
      server(),
      { getPassword: async () => 'secret' },
      { verify: async () => true },
      5_000,
      async () => undefined
    );

    const client = await waitForClient();
    client.emit('keyboard-interactive', '2FA', '', 'en', [{ prompt: 'Code:', echo: false }], () => undefined);

    await expect(promise).rejects.toThrow('Keyboard-interactive authentication was cancelled.');
    expect(end).toHaveBeenCalled();
    expect(disposeHandle).toHaveBeenCalledTimes(1);
  });

  it('rejects keyboard-interactive requests with a clear error when no prompt exists', async () => {
    const promise = testSshConnection(server(), { getPassword: async () => 'secret' }, { verify: async () => true }, 5_000);

    const client = await waitForClient();
    client.emit('keyboard-interactive', '2FA', '', 'en', [{ prompt: 'Code:', echo: false }], () => undefined);

    await expect(promise).rejects.toThrow(
      'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
    );
    expect(end).toHaveBeenCalled();
  });
});
