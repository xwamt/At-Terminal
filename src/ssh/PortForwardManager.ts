import { randomUUID } from 'node:crypto';
import type { Client } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import type { SshConnectionHandle } from './SshConnectionConfig';
import { LocalPortForward, type PortForwardClient } from './LocalPortForward';

export interface PortForwardConnection {
  client: Client;
  handle: SshConnectionHandle;
}

export interface PortForwardOptions {
  remoteHost: string;
  remotePort: number;
  /** 0 picks an ephemeral local port. */
  localPort?: number;
}

export interface ActivePortForward {
  id: string;
  serverId: string;
  serverLabel: string;
  remoteHost: string;
  remotePort: number;
  localPort: number;
  startedAt: number;
}

interface ManagedForward extends ActivePortForward {
  forward: { start(): Promise<number>; stop(): Promise<void> };
  connection: PortForwardConnection;
  onDisconnected: () => void;
}

export interface PortForwardManagerOptions {
  createConnection(server: ServerConfig): Promise<PortForwardConnection>;
  createForward?(client: PortForwardClient, options: PortForwardOptions): {
    start(): Promise<number>;
    stop(): Promise<void>;
  };
  /** Fired whenever the set of active forwards changes (status bar refresh). */
  onChange?(): void;
  /** Fired when a forward dies with its SSH connection. */
  notify?(message: string): void;
}

/**
 * Owns every local port forward the user has opened. Unlike a `Map<serverId, forward>`,
 * one server can expose several remote ports at once (MySQL + Redis, for example), and
 * each forward can be stopped independently and survives an unrelated forward's failure.
 */
export class PortForwardManager {
  private readonly forwards = new Map<string, ManagedForward>();

  constructor(private readonly options: PortForwardManagerOptions) {}

  async add(server: ServerConfig, input: PortForwardOptions): Promise<ActivePortForward> {
    const connection = await this.options.createConnection(server);
    const forward = (this.options.createForward ?? ((client, options) => new LocalPortForward(client, options)))(
      connection.client,
      input
    );
    let localPort: number;
    try {
      localPort = await forward.start();
    } catch (error) {
      connection.client.end();
      connection.handle.dispose();
      throw error;
    }

    const id = randomUUID();
    const entry: ManagedForward = {
      id,
      serverId: server.id,
      serverLabel: server.label,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      localPort,
      startedAt: Date.now(),
      forward,
      connection,
      onDisconnected: () => {
        if (!this.forwards.has(id)) {
          return;
        }
        void this.stop(id).finally(() => {
          this.options.notify?.(
            `Port forward ${localPort} to ${server.label}:${input.remoteHost}:${input.remotePort} stopped because the SSH connection closed.`
          );
        });
      }
    };
    connection.client.on('close', entry.onDisconnected);
    connection.client.on('error', entry.onDisconnected);
    this.forwards.set(id, entry);
    this.options.onChange?.();
    return snapshot(entry);
  }

  list(serverId?: string): ActivePortForward[] {
    return [...this.forwards.values()]
      .filter((entry) => serverId === undefined || entry.serverId === serverId)
      .map(snapshot);
  }

  get(id: string): ActivePortForward | undefined {
    const entry = this.forwards.get(id);
    return entry ? snapshot(entry) : undefined;
  }

  async stop(id: string): Promise<boolean> {
    const entry = this.forwards.get(id);
    if (!entry) {
      return false;
    }
    this.forwards.delete(id);
    this.options.onChange?.();
    entry.connection.client.off('close', entry.onDisconnected);
    entry.connection.client.off('error', entry.onDisconnected);
    try {
      await entry.forward.stop();
    } finally {
      entry.connection.client.end();
      entry.connection.handle.dispose();
    }
    return true;
  }

  async stopServer(serverId: string): Promise<void> {
    for (const entry of [...this.forwards.values()]) {
      if (entry.serverId === serverId) {
        await this.stop(entry.id);
      }
    }
  }

  async dispose(): Promise<void> {
    for (const entry of [...this.forwards.values()]) {
      await this.stop(entry.id);
    }
  }
}

function snapshot(entry: ManagedForward): ActivePortForward {
  return {
    id: entry.id,
    serverId: entry.serverId,
    serverLabel: entry.serverLabel,
    remoteHost: entry.remoteHost,
    remotePort: entry.remotePort,
    localPort: entry.localPort,
    startedAt: entry.startedAt
  };
}
