import type { Client } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { attachKeyboardInteractive } from '../ssh/KeyboardInteractive';
import {
  buildSshConnectionHandle,
  type HostKeyVerifier,
  type SshConnectionHandle
} from '../ssh/SshConnectionConfig';
import { getSsh2 } from '../ssh/ssh2Loader';

/**
 * How long a pooled connection may sit unused before it is closed. Long enough to cover
 * the pauses in a conversation with an agent, short enough that an abandoned chat does
 * not hold a server-side session all day.
 */
export const AGENT_POOL_IDLE_TTL_MS = 5 * 60_000;

export interface AgentSshClientLease {
  client: Client;
  release(): void;
}

class PooledConnection {
  /** Resolves once the connection is authenticated; rejects if it never got there. */
  readonly ready: Promise<Client>;
  client: Client | undefined;
  handle: SshConnectionHandle | undefined;
  /** Operations currently holding a channel (command or SFTP subsystem) on this client. */
  inFlight = 0;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed = false;

  constructor(open: (connection: PooledConnection) => Promise<Client>) {
    this.ready = open(this);
  }
}

/**
 * One authenticated `ssh2.Client` per server shared by every background Agent feature:
 * `run_remote_command` and the SFTP tools open their own channels on the same connection
 * instead of paying a second TCP + KEX + auth round trip (and, with 2FA, a second prompt).
 *
 * Connections are reference-counted while in use and reaped after
 * {@link AGENT_POOL_IDLE_TTL_MS} idle. Dropped connections leave the pool immediately so
 * the next operation reconnects instead of failing on a dead client.
 */
export class AgentSshClientPool {
  private readonly pool = new Map<string, PooledConnection>();
  private disposed = false;

  constructor(
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier: HostKeyVerifier
  ) {}

  async acquire(server: ServerConfig): Promise<AgentSshClientLease> {
    if (this.disposed) {
      throw new Error('The agent SSH client pool has been disposed.');
    }

    let connection = this.pool.get(server.id);
    if (!connection || connection.closed) {
      connection = this.open(server);
      this.pool.set(server.id, connection);
    }

    connection.inFlight += 1;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }

    const held = connection;
    try {
      return {
        client: await held.ready,
        release: () => this.release(server.id, held)
      };
    } catch (error) {
      this.release(server.id, held);
      throw error;
    }
  }

  /** Closes the pooled connection for one server, e.g. after its configuration changed. */
  disposeServer(serverId: string): void {
    const connection = this.pool.get(serverId);
    if (connection) {
      this.evict(serverId, connection);
    }
  }

  /** Closes every pooled connection. Must run on extension deactivate. */
  dispose(): void {
    this.disposed = true;
    for (const [serverId, connection] of [...this.pool]) {
      this.evict(serverId, connection);
    }
    this.pool.clear();
  }

  private open(server: ServerConfig): PooledConnection {
    const connection = new PooledConnection(async (self) => {
      // Pooling reuses an already-verified socket; every connection it opens still goes
      // through buildSshConnectionHandle, so host key verification is never skipped.
      const handle = await buildSshConnectionHandle(server, this.configManager, this.hostKeyVerifier);
      self.handle = handle;
      const client = new (await getSsh2()).Client();
      // Each in-flight channel attaches its own listeners; the default ceiling of 10 would
      // warn once a handful of concurrent commands and SFTP operations run at once.
      client.setMaxListeners(64);
      self.client = client;
      const drop = (): void => this.evict(server.id, self);
      client.on('error', drop);
      client.on('close', drop);
      client.on('end', drop);
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        attachKeyboardInteractive(client, undefined, reject);
        client.connect(handle.config);
      });
      return client;
    });
    connection.ready.catch(() => this.evict(server.id, connection));
    return connection;
  }

  private release(serverId: string, connection: PooledConnection): void {
    connection.inFlight = Math.max(0, connection.inFlight - 1);
    if (connection.inFlight > 0 || connection.closed || connection.idleTimer) {
      return;
    }
    connection.idleTimer = setTimeout(() => this.evict(serverId, connection), AGENT_POOL_IDLE_TTL_MS);
    connection.idleTimer.unref?.();
  }

  private evict(serverId: string, connection: PooledConnection): void {
    if (connection.closed) {
      return;
    }
    connection.closed = true;
    if (connection.idleTimer) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
    }
    if (this.pool.get(serverId) === connection) {
      this.pool.delete(serverId);
    }
    connection.client?.end();
    connection.handle?.dispose();
  }
}
