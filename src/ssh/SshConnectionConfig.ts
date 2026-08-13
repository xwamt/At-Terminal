import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig, type VerifyCallback } from 'ssh2';
import type { ServerConfig } from '../config/schema';

export interface PasswordProvider {
  getPassword(id: string): Promise<string | undefined>;
}

export interface ServerLookup {
  getServer(id: string): Promise<ServerConfig | undefined>;
}

export type SshConnectionProvider = PasswordProvider & Partial<ServerLookup>;

export interface SshConnectionHandle {
  config: ConnectConfig;
  dispose(): void;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
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

  if (!server.privateKeyPath) {
    throw new Error('Missing private key path.');
  }

  return {
    ...base,
    privateKey: await readFile(server.privateKeyPath, 'utf8')
  };
}

export async function buildSshConnectionHandle(
  server: ServerConfig,
  provider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier
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

  const jumpClient = new Client();
  try {
    const jumpConfig = await buildSshConnectConfig({ ...jumpHost, jumpHostId: undefined }, provider, hostKeyVerifier);

    await new Promise<void>((resolve, reject) => {
      jumpClient.once('ready', resolve);
      jumpClient.once('error', reject);
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
