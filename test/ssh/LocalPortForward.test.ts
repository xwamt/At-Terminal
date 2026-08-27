import { connect, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalPortForward, type PortForwardClient } from '../../src/ssh/LocalPortForward';

function echoClient(): { client: PortForwardClient; forwardOut: ReturnType<typeof vi.fn> } {
  const forwardOut = vi.fn(
    (
      _srcIP: string,
      _srcPort: number,
      _dstIP: string,
      _dstPort: number,
      callback: (error: Error | undefined, channel: PassThrough) => void
    ) => {
      // A PassThrough echoes whatever the local socket writes straight back to it.
      callback(undefined, new PassThrough());
    }
  );
  return { client: { forwardOut } as PortForwardClient, forwardOut };
}

function connectTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
    socket.once('error', reject);
  });
}

function nextData(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('data', (data) => resolve(data.toString('utf8')));
  });
}

const forwards: LocalPortForward[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const forward of forwards.splice(0)) {
    await forward.stop();
  }
});

describe('LocalPortForward', () => {
  it('tunnels local connections through forwardOut to the remote target', async () => {
    const { client, forwardOut } = echoClient();
    const forward = new LocalPortForward(client, { remoteHost: 'db.internal', remotePort: 5432 });
    forwards.push(forward);

    const port = await forward.start();
    expect(port).toBeGreaterThan(0);
    expect(forward.isActive()).toBe(true);

    const socket = await connectTo(port);
    sockets.push(socket);
    socket.write('ping');

    expect(await nextData(socket)).toBe('ping');
    expect(forwardOut).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      'db.internal',
      5432,
      expect.any(Function)
    );
    await vi.waitFor(() => expect(forward.activeConnectionCount()).toBe(1));
  });

  it('destroys the local socket when forwardOut fails', async () => {
    const client: PortForwardClient = {
      forwardOut: (_srcIP, _srcPort, _dstIP, _dstPort, callback) => {
        callback(new Error('administratively prohibited'), undefined as never);
      }
    };
    const forward = new LocalPortForward(client, { remoteHost: 'db.internal', remotePort: 5432 });
    forwards.push(forward);

    const port = await forward.start();
    const socket = await connectTo(port);
    sockets.push(socket);

    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(forward.activeConnectionCount()).toBe(0);
  });

  it('stops accepting connections and closes active tunnels on stop', async () => {
    const { client } = echoClient();
    const forward = new LocalPortForward(client, { remoteHost: 'db.internal', remotePort: 5432 });
    forwards.push(forward);

    const port = await forward.start();
    const socket = await connectTo(port);
    sockets.push(socket);
    await vi.waitFor(() => expect(forward.activeConnectionCount()).toBe(1));

    await forward.stop();

    expect(forward.isActive()).toBe(false);
    expect(forward.activeConnectionCount()).toBe(0);
    await expect(connectTo(port)).rejects.toThrow();
  });

  it('rejects a second start while running', async () => {
    const { client } = echoClient();
    const forward = new LocalPortForward(client, { remoteHost: 'db.internal', remotePort: 5432 });
    forwards.push(forward);

    await forward.start();

    await expect(forward.start()).rejects.toThrow('The port forward is already running.');
  });

  it('can start again after being stopped', async () => {
    const { client } = echoClient();
    const forward = new LocalPortForward(client, { remoteHost: 'db.internal', remotePort: 5432 });
    forwards.push(forward);

    const firstPort = await forward.start();
    await forward.stop();
    const secondPort = await forward.start();

    expect(secondPort).toBeGreaterThan(0);
    expect(forward.isActive()).toBe(true);
    expect(firstPort).not.toBe(0);
  });
});
