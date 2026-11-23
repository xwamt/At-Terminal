import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';

const connect = vi.fn();
const end = vi.fn();
const exec = vi.fn();
const disposeHandle = vi.fn();
const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connect = connect;
  end = end;
  exec = exec;
  setMaxListeners = vi.fn();
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
    config: { host: 'example.com' },
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

function createExecStream() {
  const stream = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    close(): void;
    signal: ReturnType<typeof vi.fn>;
  };
  stream.stderr = new EventEmitter();
  stream.close = vi.fn();
  stream.signal = vi.fn();
  return stream;
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

const hostKeyVerifier = { verify: async () => true };

beforeEach(() => {
  vi.useRealTimers();
  connect.mockReset();
  end.mockReset();
  exec.mockReset();
  disposeHandle.mockReset();
  clients.length = 0;
});

describe('RemoteCommandExecutor optimizations', () => {
  it('disposeServer closes only that server connection so the next command reconnects', async () => {
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const firstStream = createExecStream();
    exec.mockImplementationOnce((_command: string, callback: Function) => callback(undefined, firstStream));
    const first = executor.execute(server(), { command: 'pwd', timeoutMs: 5_000, maxOutputBytes: 1024 });
    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    firstStream.emit('close', 0, undefined);
    await first;

    executor.disposeServer('server-1');
    expect(end).toHaveBeenCalledTimes(1);
    expect(disposeHandle).toHaveBeenCalledTimes(1);

    const secondStream = createExecStream();
    exec.mockImplementationOnce((_command: string, callback: Function) => callback(undefined, secondStream));
    const second = executor.execute(server(), { command: 'whoami', timeoutMs: 5_000, maxOutputBytes: 1024 });
    await flushPromises();
    clients[1].emit('ready');
    await flushPromises();
    secondStream.emit('close', 0, undefined);
    await second;

    expect(clients).toHaveLength(2);
  });

  it('aborts a running command with TERM and rejects as cancelled', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);
    const controller = new AbortController();

    const promise = executor.execute(server(), {
      command: 'sleep 60',
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      signal: controller.signal
    });
    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    controller.abort();

    await expect(promise).rejects.toThrow('Remote command was cancelled.');
    expect(stream.signal).toHaveBeenCalledWith('TERM');
    expect(stream.close).toHaveBeenCalledTimes(1);
  });

  it('does not leave a replacement character when a byte cap splits a UTF-8 character', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never, hostKeyVerifier);

    const promise = executor.execute(server(), {
      command: 'printf 中文',
      timeoutMs: 5_000,
      maxOutputBytes: 4
    });
    await flushPromises();
    clients[0].emit('ready');
    await flushPromises();
    stream.emit('data', Buffer.from('中文', 'utf8'));
    stream.emit('close', 0, undefined);

    const result = await promise;
    expect(result.truncated).toBe(true);
    expect(result.stdout).toBe('中');
    expect(result.stdout).not.toContain('\uFFFD');
  });
});
