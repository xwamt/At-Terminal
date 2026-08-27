import { readFile } from 'node:fs/promises';
import type { ConnectConfig, VerifyCallback } from 'ssh2';
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
}

export interface SshConnectionHandle {
  config: ConnectConfig;
  dispose(): void;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
}

const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

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

export async function buildSshConnectionHandle(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  options: SshConnectOptions = {}
): Promise<SshConnectionHandle> {
  requireHostKeyVerifier(hostKeyVerifier);
  if (!server.jumpHostId) {
    return {
      config: await buildSshConnectConfig(server, provider, hostKeyVerifier),
      dispose: () => undefined
    };
  }

  if (!provider.getServer) {
    throw new Error('Jump host lookup is not available.');
  }

  const jumpHost = await provider.getServer(server.jumpHostId);
  if (!jumpHost) {
    throw new Error(`Jump host "${server.jumpHostId}" was not found.`);
  }

  const { Client } = await getSsh2();
  const jumpClient = new Client();
  try {
    const jumpConfig = await buildSshConnectConfig({ ...jumpHost, jumpHostId: undefined }, provider, hostKeyVerifier);

    await new Promise<void>((resolve, reject) => {
      jumpClient.once('ready', resolve);
      jumpClient.once('error', reject);
      attachKeyboardInteractive(jumpClient, options.keyboardInteractivePrompt, reject);
      jumpClient.connect(jumpConfig);
    });

    const sock = await new Promise<ConnectConfig['sock']>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, server.host, server.port, (error, channel) => {
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
      dispose: () => {
        jumpClient.end();
      }
    };
  } catch (error) {
    jumpClient.end();
    throw error;
  }
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
