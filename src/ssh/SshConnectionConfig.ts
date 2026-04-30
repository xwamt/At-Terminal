import { readFile } from 'node:fs/promises';
import type { ConnectConfig, VerifyCallback } from 'ssh2';
import type { ServerConfig } from '../config/schema';

export interface PasswordProvider {
  getPassword(id: string): Promise<string | undefined>;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
}

export async function buildSshConnectConfig(
  server: ServerConfig,
  passwordProvider: PasswordProvider,
  hostKeyVerifier?: HostKeyVerifier
): Promise<ConnectConfig> {
  const base: ConnectConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    keepaliveInterval: server.keepAliveInterval * 1000,
    hostHash: 'sha256',
    hostVerifier: createHostVerifier(server, hostKeyVerifier)
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

function createHostVerifier(
  server: ServerConfig,
  hostKeyVerifier: HostKeyVerifier | undefined
): ConnectConfig['hostVerifier'] {
  if (!hostKeyVerifier) {
    return undefined;
  }

  const verifyHost = (fingerprint: string, verify: VerifyCallback): void => {
    void hostKeyVerifier.verify(server.host, server.port, fingerprint).then(
      verify,
      () => verify(false)
    );
  };

  return verifyHost as ConnectConfig['hostVerifier'];
}
