import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import type { ServerConfig } from '../../src/config/schema';

const connect = vi.fn();
const end = vi.fn();
const exec = vi.fn();
const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connect = connect;
  end = end;
  exec = exec;
}

vi.mock('ssh2', () => ({
  Client: vi.fn().mockImplementation(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  })
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectConfig: vi.fn(async () => ({ host: 'example.com' }))
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
  };
  stream.stderr = new EventEmitter();
  stream.close = vi.fn();
  return stream;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useRealTimers();
  connect.mockReset();
  end.mockReset();
  exec.mockReset();
  clients.length = 0;
});

describe('RemoteCommandExecutor', () => {
  it('executes a remote command and returns structured output', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never);

    const promise = executor.execute(server(), {
      command: 'uname -a',
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    stream.emit('data', Buffer.from('Linux\n'));
    stream.stderr.emit('data', Buffer.from('warn\n'));
    stream.emit('close', 0, undefined);

    await expect(promise).resolves.toMatchObject({
      serverId: 'server-1',
      serverLabel: 'Production',
      host: 'example.com',
      command: 'uname -a',
      exitCode: 0,
      signal: undefined,
      stdout: 'Linux\n',
      stderr: 'warn\n',
      timedOut: false,
      truncated: false
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('wraps cwd with a POSIX cd before command execution', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never);

    const promise = executor.execute(server(), {
      command: 'npm test',
      cwd: '/var/www/my app',
      timeoutMs: 5_000,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    stream.emit('close', 0, undefined);
    await promise;

    expect(exec).toHaveBeenCalledWith("cd '/var/www/my app' && npm test", expect.any(Function));
  });

  it('times out long-running commands and closes the stream', async () => {
    vi.useFakeTimers();
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never);

    const promise = executor.execute(server(), {
      command: 'sleep 60',
      timeoutMs: 100,
      maxOutputBytes: 1024
    });

    await flushPromises();
    clients[0].emit('ready');
    vi.advanceTimersByTime(100);

    await expect(promise).resolves.toMatchObject({
      exitCode: null,
      timedOut: true,
      stderr: 'Command timed out after 100ms.'
    });
    expect(stream.close).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('truncates stdout and stderr independently', async () => {
    const stream = createExecStream();
    exec.mockImplementation((_command: string, callback: Function) => callback(undefined, stream));
    const executor = new RemoteCommandExecutor({ getPassword: async () => 'secret' } as never);

    const promise = executor.execute(server(), {
      command: 'cat big.log',
      timeoutMs: 5_000,
      maxOutputBytes: 4
    });

    await flushPromises();
    clients[0].emit('ready');
    stream.emit('data', Buffer.from('abcdef'));
    stream.stderr.emit('data', Buffer.from('uvwxyz'));
    stream.emit('close', 0, undefined);

    await expect(promise).resolves.toMatchObject({
      stdout: 'abcd',
      stderr: 'uvwx',
      truncated: true
    });
  });
});
