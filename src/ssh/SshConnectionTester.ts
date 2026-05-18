import { Client } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { buildSshConnectConfig, type HostKeyVerifier, type PasswordProvider } from './SshConnectionConfig';

const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export async function testSshConnection(
  server: ServerConfig,
  passwordProvider: PasswordProvider,
  hostKeyVerifier?: HostKeyVerifier,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS
): Promise<void> {
  const config = await buildSshConnectConfig(server, passwordProvider, hostKeyVerifier);
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      rejectOnce(new Error(`Connection test timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      client.removeAllListeners('ready');
      client.removeAllListeners('error');
      client.end();
    };

    const resolveOnce = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };

    const rejectOnce = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    client.once('ready', resolveOnce);
    client.once('error', rejectOnce);
    client.connect({ ...config, readyTimeout: timeoutMs });
  });
}
