import { readFile } from 'node:fs/promises';
import type { Client, ConnectConfig, VerifyCallback } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { attachKeyboardInteractive, type KeyboardInteractivePrompt } from './KeyboardInteractive';
import { getSsh2 } from './ssh2Loader';

export interface PasswordProvider {
  getPassword(id: string): Promise<string | undefined>;
  /**
   * Optional so pre-passphrase implementers (e.g. SftpTypes' PasswordSource) still
   * satisfy the interface; absent means "no stored passphrase". An encrypted key
   * without a passphrase fails ssh2's key parse with its own clear error.
   */
  getPassphrase?(id: string): Promise<string | undefined>;
}

export interface ServerLookup {
  getServer(id: string): Promise<ServerConfig | undefined>;
}

export type SshConnectionProvider = PasswordProvider & Partial<ServerLookup>;

export interface SshConnectOptions {
  /**
   * Answers keyboard-interactive rounds (2FA, PAM). When absent, a server that asks
   * for one gets its connection aborted with a clear error instead of hanging --
   * background paths (agent SFTP, pooled command executors) have no UI to prompt.
   */
  keyboardInteractivePrompt?: KeyboardInteractivePrompt;
  /** Pool used to reuse one authenticated connection per jump host. */
  jumpHostPool?: JumpHostPool;
}

export interface SshConnectionHandle {
  config: ConnectConfig;
  dispose(): void;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
}

/** A hard ceiling so a misconfigured chain cannot recurse forever or open dozens of hops. */
export const MAX_JUMP_HOPS = 4;
/** Idle jump connections are reaped after this, mirroring a short-lived connection pool. */
export const JUMP_HOST_IDLE_TTL_MS = 60_000;

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

interface JumpClientLease {
  client: Client;
  release(): void;
}

interface JumpPoolEntry {
  key: string;
  jumpHostId: string;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  closed: boolean;
  ready: Promise<{ client: Client; dispose(): void }>;
  dispose(): void;
}

/**
 * Reuses one authenticated `ssh2.Client` per jump host across every consumer (terminal,
 * SFTP view, MCP command executor and MCP SFTP). Without it each consumer opened its own
 * parallel connection to the same bastion, which multiplies 2FA prompts and can trip
 * `MaxStartups` / `MaxSessions` limits.
 *
 * Each {@link SshConnectionHandle} owns one forwarded tunnel on the shared client and
 * releases its reference on dispose; the client itself closes after a short idle TTL.
 */
export class JumpHostPool {
  private readonly entries = new Map<string, JumpPoolEntry>();

  async acquire(
    jumpHostId: string,
    signature: string,
    open: () => Promise<{ client: Client; dispose(): void }>
  ): Promise<JumpClientLease> {
    const key = `${jumpHostId}\u0000${signature}`;
    let entry = this.entries.get(key);
    if (!entry || entry.closed) {
      const created: JumpPoolEntry = {
        key,
        jumpHostId,
        refs: 0,
        idleTimer: undefined,
        closed: false,
        ready: Promise.resolve().then(open),
        dispose: () => undefined
      };
      created.ready.then(
        (opened) => {
          created.dispose = opened.dispose;
          // A jump host can close on its own (restart, idle timeout on the bastion).
          // Evict it immediately so the short idle TTL cannot hand out a dead client.
          const drop = (): void => this.evict(created);
          opened.client.on('close', drop);
          opened.client.on('error', drop);
          opened.client.on('end', drop);
        },
        () => this.evict(created)
      );
      this.entries.set(key, created);
      entry = created;
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    const held = entry;
    try {
      const opened = await held.ready;
      if (held.closed) {
        throw new Error('Jump host connection closed before it was ready.');
      }
      return {
        client: opened.client,
        release: () => this.release(held)
      };
    } catch (error) {
      this.release(held);
      throw error;
    }
  }

  /** Closes every cached connection to one jump host (its configuration changed or was deleted). */
  disposeJumpHost(jumpHostId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.jumpHostId === jumpHostId) {
        this.evict(entry);
      }
    }
  }

  /** Closes every cached jump-host connection. */
  disposeAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.evict(entry);
    }
    this.entries.clear();
  }

  private release(entry: JumpPoolEntry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.closed || entry.idleTimer) {
      return;
    }
    entry.idleTimer = setTimeout(() => this.evict(entry), JUMP_HOST_IDLE_TTL_MS);
    entry.idleTimer.unref?.();
  }

  private evict(entry: JumpPoolEntry): void {
    if (entry.closed) {
      return;
    }
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    entry.dispose();
  }
}

const defaultJumpHostPool = new JumpHostPool();

/** Drops cached jump-host connections, e.g. after a server edit/delete. */
export function disposeJumpHostConnections(jumpHostId?: string): void {
  if (jumpHostId) {
    defaultJumpHostPool.disposeJumpHost(jumpHostId);
    return;
  }
  defaultJumpHostPool.disposeAll();
}

export async function buildSshConnectionHandle(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions = {}
): Promise<SshConnectionHandle> {
  requireHostKeyVerifier(hostKeyVerifier);
  return await buildSshConnectionHandleChain(server, provider, hostKeyVerifier, options, new Set(), 0);
}

async function buildSshConnectionHandleChain(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions,
  visited: ReadonlySet<string>,
  depth: number
): Promise<SshConnectionHandle> {
  if (!server.jumpHostId) {
    return {
      config: await buildSshConnectConfig(server, provider, hostKeyVerifier),
      dispose: () => undefined
    };
  }

  if (!provider.getServer) {
    throw new Error('Jump host lookup is not available.');
  }
  if (visited.has(server.id)) {
    throw new Error(
      `Circular jump host chain detected: ${[...visited, server.id].join(' -> ')}.`
    );
  }
  if (depth >= MAX_JUMP_HOPS) {
    throw new Error(`Jump host chain exceeds the maximum of ${MAX_JUMP_HOPS} hops.`);
  }

  const jumpHost = await provider.getServer(server.jumpHostId);
  if (!jumpHost) {
    throw new Error(`Jump host "${server.jumpHostId}" was not found.`);
  }
  if (visited.has(jumpHost.id) || jumpHost.id === server.id) {
    throw new Error(
      `Circular jump host chain detected: ${[...visited, server.id, jumpHost.id].join(' -> ')}.`
    );
  }

  const nextVisited = new Set(visited).add(server.id);
  const pool = options.jumpHostPool ?? defaultJumpHostPool;
  const lease = await pool.acquire(jumpHost.id, jumpHostSignature(jumpHost), async () => {
    // Resolve the jump host's own route first (A -> B -> C), then dial B through it.
    const upstream = await buildSshConnectionHandleChain(
      jumpHost,
      provider,
      hostKeyVerifier,
      options,
      nextVisited,
      depth + 1
    );
    const { Client } = await getSsh2();
    const jumpClient = new Client();
    // A jump host socket can fail twice (handshake, then the forwarded channel). The
    // `once('error', reject)` in the handshake only owns the first emission; this
    // permanent listener keeps the second from becoming an uncaughtException.
    jumpClient.on('error', () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        jumpClient.once('ready', resolve);
        jumpClient.once('error', reject);
        attachKeyboardInteractive(jumpClient, options.keyboardInteractivePrompt, reject);
        jumpClient.connect(upstream.config);
      });
      return {
        client: jumpClient,
        dispose: () => {
          jumpClient.end();
          upstream.dispose();
        }
      };
    } catch (error) {
      jumpClient.end();
      upstream.dispose();
      throw error;
    }
  });

  try {
    const sock = await new Promise<ConnectConfig['sock']>((resolve, reject) => {
      lease.client.forwardOut('127.0.0.1', 0, server.host, server.port, (error, channel) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(channel);
      });
    });

    return {
      config: {
        ...(await buildSshConnectConfig(server, provider, hostKeyVerifier)),
        sock
      },
      dispose: () => lease.release()
    };
  } catch (error) {
    lease.release();
    throw error;
  }
}

/** Everything that changes the TCP/auth identity of a jump host connection. */
function jumpHostSignature(jumpHost: ServerConfig): string {
  return JSON.stringify([
    jumpHost.host,
    jumpHost.port,
    jumpHost.username,
    jumpHost.authType,
    jumpHost.privateKeyPath ?? '',
    jumpHost.jumpHostId ?? ''
  ]);
}

/**
 * ssh2 accepts any host key when `hostVerifier` is absent, so a missing verifier is a silent
 * MITM opening rather than a degraded mode. Callers are typed to always supply one; this guards
 * the untyped edges (JS callers, structurally-typed injection) by failing closed.
 */
export function requireHostKeyVerifier(hostKeyVerifier: HostKeyVerifier | undefined): HostKeyVerifier {
  if (!hostKeyVerifier) {
    throw new Error(
      'A host key verifier is required. Refusing to open an SSH connection that would accept any host key.'
    );
  }
  return hostKeyVerifier;
}

/**
 * Where ssh2 should reach the SSH agent. Parameters exist for tests; production callers
 * use the process defaults.
 */
export function resolveAgentSocket(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (env.SSH_AUTH_SOCK) {
    return env.SSH_AUTH_SOCK;
  }
  if (platform === 'win32') {
    return WINDOWS_OPENSSH_AGENT_PIPE;
  }
  throw new Error(
    'Missing SSH agent socket. Set the SSH_AUTH_SOCK environment variable or start an SSH agent.'
  );
}

export async function buildSshConnectConfig(
  server: ServerConfig,
  passwordProvider: PasswordProvider,
  hostKeyVerifier: HostKeyVerifier
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    keepaliveInterval: server.keepAliveInterval * 1000,
    // 2FA-style prompts arrive as keyboard-interactive requests. Opting in is harmless
    // for servers that never send one, and every connect path attaches
    // attachKeyboardInteractive so an unanswerable request fails fast instead of hanging.
    tryKeyboard: true,
    hostHash: 'sha256',
    hostVerifier: createHostVerifier(server, requireHostKeyVerifier(hostKeyVerifier))
  };

  if (server.authType === 'password') {
    const password = await passwordProvider.getPassword(server.id);
    if (!password) {
      throw new Error('Missing password. Edit the server configuration and enter a password.');
    }
    return { ...base, password };
  }

  if (server.authType === 'agent') {
    return { ...base, agent: resolveAgentSocket() };
  }

  if (!server.privateKeyPath) {
    throw new Error('Missing private key path.');
  }

  const passphrase = await passwordProvider.getPassphrase?.(server.id);
  return {
    ...base,
    privateKey: await readFile(server.privateKeyPath, 'utf8'),
    ...(passphrase === undefined ? {} : { passphrase })
  };
}

function createHostVerifier(
  server: ServerConfig,
  hostKeyVerifier: HostKeyVerifier
): ConnectConfig['hostVerifier'] {
  const verifyHost = (fingerprint: string, verify: VerifyCallback): void => {
    void hostKeyVerifier.verify(server.host, server.port, fingerprint).then(
      verify,
      () => verify(false)
    );
  };

  return verifyHost as ConnectConfig['hostVerifier'];
}
