import { createServer, type Server, type Socket } from 'node:net';

/** Structural subset of ssh2's ClientChannel; a Duplex is enough for the pipe. */
export interface PortForwardChannel extends NodeJS.ReadWriteStream {
  destroy(): void;
}

/**
 * Structural subset of ssh2's Client. The forward rides an existing connection --
 * callers that only have a ServerConfig open one through buildSshConnectionHandle
 * first and own its lifecycle.
 */
export interface PortForwardClient {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, channel: PortForwardChannel) => void
  ): void;
}

export interface LocalPortForwardOptions {
  remoteHost: string;
  remotePort: number;
  /** Local port to bind; 0 (the default) picks a free ephemeral port. */
  localPort?: number;
  /** Bind address; loopback by default so the tunnel is not exposed on the LAN. */
  localHost?: string;
}

/**
 * A local `-L` style forward: listens on localHost:localPort and pipes every accepted
 * TCP connection through `forwardOut` to remoteHost:remotePort on the SSH server's
 * side. UI-only by design -- this is intentionally not exposed as an MCP tool.
 */
export class LocalPortForward {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly client: PortForwardClient,
    private readonly options: LocalPortForwardOptions
  ) {}

  /** Resolves with the bound local port once the listener is accepting connections. */
  async start(): Promise<number> {
    if (this.server) {
      throw new Error('The port forward is already running.');
    }
    const server = createServer((socket) => this.handleConnection(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.localPort ?? 0, this.options.localHost ?? '127.0.0.1', resolve);
      });
    } catch (error) {
      this.server = undefined;
      throw error;
    }
    const port = this.localPort();
    if (port === undefined) {
      throw new Error('The port forward listener reported no bound port.');
    }
    return port;
  }

  localPort(): number | undefined {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  }

  isActive(): boolean {
    return Boolean(this.server?.listening);
  }

  activeConnectionCount(): number {
    return this.sockets.size;
  }

  /** Stops accepting connections and tears down every active tunnel. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());

    this.client.forwardOut(
      socket.localAddress ?? '127.0.0.1',
      socket.remotePort ?? 0,
      this.options.remoteHost,
      this.options.remotePort,
      (error, channel) => {
        if (error) {
          socket.destroy();
          return;
        }
        if (socket.destroyed) {
          channel.destroy();
          return;
        }
        socket.pipe(channel);
        channel.pipe(socket);
        channel.on('error', () => socket.destroy());
        channel.on('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
      }
    );
  }
}
