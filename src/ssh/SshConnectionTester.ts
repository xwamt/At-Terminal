import { Client } from 'ssh2';
import type { ServerConfig } from '../config/schema';
import { buildSshConnectionHandle, type HostKeyVerifier, type SshConnectionProvider } from './SshConnectionConfig';

const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export async function testSshConnection(
  server: ServerConfig,
  passwordProvider: SshConnectionProvider,
  hostKeyVerifier?: HostKeyVerifier,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS
): Promise<void> {
  const handle = await buildSshConnectionHandle(server, passwordProvider, hostKeyVerifier);
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
      handle.dispose();
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
    client.connect({ ...handle.config, readyTimeout: timeoutMs });
  });
}
