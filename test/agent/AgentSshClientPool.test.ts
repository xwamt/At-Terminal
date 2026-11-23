import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSshClientPool } from '../../src/agent/AgentSshClientPool';
import { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import { SftpAgentService } from '../../src/agent/SftpAgentService';
import type { ServerConfig } from '../../src/config/schema';
import { SftpSession } from '../../src/sftp/SftpSession';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import { buildSshConnectionHandle } from '../../src/ssh/SshConnectionConfig';

const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  connect = vi.fn(() => {
    queueMicrotask(() => this.emit('ready'));
  });
  end = vi.fn();
  setMaxListeners = vi.fn();
  exec = vi.fn((_command: string, callback: Function) => {
    const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter; close(): void };
    stream.stderr = new EventEmitter();
    stream.close = vi.fn();
    callback(undefined, stream);
    queueMicrotask(() => stream.emit('close', 0, undefined));
  });
  sftp = vi.fn((callback: Function) => {
    callback(undefined, {
      realpath: (path: string, done: Function) => done(undefined, path === '.' ? '/home/deploy' : path),
      stat: (_path: string, done: Function) => done(undefined, { size: 0, mtime: 1 }),
      on: vi.fn(),
      end: vi.fn()
    });
  });
}

vi.mock('ssh2', () => ({
  Client: vi.fn(() => {
    const client = new FakeClient();
    clients.push(client);
    return client;
  })
}));

vi.mock('../../src/ssh/SshConnectionConfig', () => ({
  buildSshConnectionHandle: vi.fn(async () => ({
    config: { host: 'example.com' },
    dispose: vi.fn()
  }))
}));

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'server-1',
    host: 'server-1.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    backgroundConnectionAllowed: true
  };
}

beforeEach(() => {
  clients.length = 0;
  vi.mocked(buildSshConnectionHandle).mockClear();
});

describe('AgentSshClientPool', () => {
  it('shares one SSH connection between run_remote_command and background SFTP', async () => {
    const configManager = { getPassword: async () => 'secret' } as never;
    const hostKeyVerifier = { verify: async () => true };
    const pool = new AgentSshClientPool(configManager, hostKeyVerifier);
    const executor = new RemoteCommandExecutor(configManager, hostKeyVerifier, pool);
    const service = new SftpAgentService({
      terminalContext: new TerminalContextRegistry(),
      createSession: () => {
        throw new Error('terminal sessions should not be used');
      },
      createBackgroundSession: (target) =>
        new SftpSession(target.server, configManager, hostKeyVerifier, {
          allowSudoFallback: false,
          acquireClient: () => pool.acquire(target.server)
        }),
      authorizer: {
        requireWrite: vi.fn(async () => undefined),
        requireDelete: vi.fn(async () => undefined)
      },
      resolveBackgroundServer: async () => server()
    });

    const result = await executor.execute(server(), { command: 'pwd', timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);

    const stat = await service.statPath({ serverId: 'server-1', path: '.' });
    expect(stat.path).toBe('/home/deploy');

    expect(clients).toHaveLength(1);
    expect(buildSshConnectionHandle).toHaveBeenCalledTimes(1);

    executor.dispose();
    service.dispose();
    expect(clients[0].end).toHaveBeenCalled();
  });

  it('disposeServer closes the shared client so both features reconnect', async () => {
    const configManager = { getPassword: async () => 'secret' } as never;
    const hostKeyVerifier = { verify: async () => true };
    const pool = new AgentSshClientPool(configManager, hostKeyVerifier);

    const first = await pool.acquire(server());
    first.release();
    pool.disposeServer('server-1');
    expect(clients[0].end).toHaveBeenCalledTimes(1);

    const second = await pool.acquire(server());
    expect(clients).toHaveLength(2);
    second.release();
    pool.dispose();
  });
});
