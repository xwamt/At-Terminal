import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { PortForwardManager } from '../../src/ssh/PortForwardManager';
import { refreshPortForwardStatusBar } from '../../src/commands/portForwardCommands';

class FakeClient extends EventEmitter {
  end = vi.fn();
  setMaxListeners = vi.fn();
}

function server(id = 'server-1'): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function setup() {
  const clients: FakeClient[] = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  let nextPort = 40000;
  const onChange = vi.fn();
  const notify = vi.fn();
  const manager = new PortForwardManager({
    createConnection: async () => {
      const client = new FakeClient();
      clients.push(client);
      return {
        client: client as never,
        handle: { config: {}, dispose: vi.fn() }
      };
    },
    createForward: (_client, options) => {
      const stop = vi.fn(async () => undefined);
      stops.push(stop);
      return {
        start: async () => options.localPort || nextPort++,
        stop
      };
    },
    onChange,
    notify
  });
  return { manager, clients, stops, onChange, notify };
}

describe('PortForwardManager', () => {
  it('allows multiple forwards to the same server on different ports', async () => {
    const { manager, onChange } = setup();

    const mysql = await manager.add(server(), { remoteHost: '127.0.0.1', remotePort: 3306 });
    const redis = await manager.add(server(), { remoteHost: '127.0.0.1', remotePort: 6379 });

    expect(manager.list()).toHaveLength(2);
    expect(manager.list('server-1').map((forward) => forward.remotePort)).toEqual([3306, 6379]);
    expect(mysql.localPort).not.toBe(redis.localPort);
    expect(onChange).toHaveBeenCalledTimes(2);
    await manager.dispose();
  });

  it('stops one forward without touching the others', async () => {
    const { manager, stops, clients } = setup();
    const first = await manager.add(server(), { remoteHost: '127.0.0.1', remotePort: 3306 });
    const second = await manager.add(server(), { remoteHost: '127.0.0.1', remotePort: 6379 });

    await manager.stop(first.id);

    expect(manager.list().map((forward) => forward.id)).toEqual([second.id]);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();
    expect(clients[0].end).toHaveBeenCalledTimes(1);
    expect(clients[1].end).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it('drops a forward and notifies when its SSH connection closes', async () => {
    const { manager, clients, notify } = setup();
    await manager.add(server(), { remoteHost: '127.0.0.1', remotePort: 3306 });

    clients[0].emit('close');
    await vi.waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining('stopped because the SSH connection closed')
      )
    );
    expect(manager.list()).toHaveLength(0);
  });


  it('mirrors the active forward count in the status bar', () => {
    const statusBar = {
      text: '',
      tooltip: '',
      command: undefined as string | undefined,
      show: vi.fn(),
      hide: vi.fn()
    };

    refreshPortForwardStatusBar(statusBar as never, [
      { localPort: 40001, serverLabel: 'prod', remoteHost: '127.0.0.1', remotePort: 3306 },
      { localPort: 40002, serverLabel: 'prod', remoteHost: '127.0.0.1', remotePort: 6379 }
    ]);

    expect(statusBar.text).toBe('$(plug) AT Forwards: 2');
    expect(statusBar.command).toBe('sshManager.managePortForwards');
    expect(statusBar.show).toHaveBeenCalledTimes(1);

    refreshPortForwardStatusBar(statusBar as never, []);
    expect(statusBar.hide).toHaveBeenCalledTimes(1);
  });

  it('cleans up one server without affecting another', async () => {
    const { manager } = setup();
    await manager.add(server('server-1'), { remoteHost: '127.0.0.1', remotePort: 3306 });
    await manager.add(server('server-2'), { remoteHost: '127.0.0.1', remotePort: 5432 });

    await manager.stopServer('server-1');

    expect(manager.list().map((forward) => forward.serverId)).toEqual(['server-2']);
    await manager.dispose();
  });
});
