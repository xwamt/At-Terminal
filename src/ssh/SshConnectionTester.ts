import type { ServerConfig } from '../config/schema';
import { attachKeyboardInteractive, type KeyboardInteractivePrompt } from './KeyboardInteractive';
import { buildSshConnectionHandle, type HostKeyVerifier, type SshConnectionProvider } from './SshConnectionConfig';
import { getSsh2 } from './ssh2Loader';
import { t } from '../i18n/t';

const DEFAULT_TEST_TIMEOUT_MS = 10_000;

export async function testSshConnection(
  server: ServerConfig,
  passwordProvider: SshConnectionProvider,
  hostKeyVerifier: HostKeyVerifier,
  timeoutMs = DEFAULT_TEST_TIMEOUT_MS,
  keyboardInteractivePrompt?: KeyboardInteractivePrompt
): Promise<void> {
  const handle = await buildSshConnectionHandle(server, passwordProvider, hostKeyVerifier, {
    keyboardInteractivePrompt
  });
  const { Client } = await getSsh2();
  const client = new Client();

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      rejectOnce(new Error(t('Connection test timed out after {timeoutMs}ms.', { timeoutMs })));
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
    attachKeyboardInteractive(client, keyboardInteractivePrompt, rejectOnce);
    client.connect({ ...handle.config, readyTimeout: timeoutMs });
  });
}
