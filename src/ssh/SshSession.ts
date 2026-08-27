import type { Client, ClientChannel, ShellOptions } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { t } from '../i18n/t';
import { attachKeyboardInteractive, type KeyboardInteractivePrompt } from './KeyboardInteractive';
import { buildSshConnectionHandle, type HostKeyVerifier, type SshConnectionHandle } from './SshConnectionConfig';
import { getSsh2 } from './ssh2Loader';

export type SshSessionState = 'connecting' | 'connected' | 'disconnected';

/**
 * Structured so consumers branch on `state` instead of matching English substrings,
 * which broke as soon as `text` was localized. `text` is display-ready copy from `t()`.
 */
export interface SshSessionStatus {
  state: SshSessionState;
  text: string;
}

export interface SshSessionEvents {
  output(data: Buffer): void;
  status(status: SshSessionStatus): void;
  error(error: unknown): void;
}

export class SshSession {
  private client: Client | undefined;
  private shell: ClientChannel | undefined;
  private rows = 24;
  private cols = 80;
  private connected = false;
  private connectionHandle: SshConnectionHandle | undefined;

  constructor(
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly events: SshSessionEvents,
    private readonly hostKeyVerifier: HostKeyVerifier,
    private readonly keyboardInteractivePrompt?: KeyboardInteractivePrompt
  ) {}

  async connect(): Promise<void> {
    this.events.status({
      state: 'connecting',
      text: t('Connecting to {host}:{port}...', { host: this.server.host, port: this.server.port })
    });
    const handle = await this.buildConnectionHandle();
    this.connectionHandle = handle;
    const { Client } = await getSsh2();
    const client = new Client();
    this.client = client;

    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        attachKeyboardInteractive(client, this.keyboardInteractivePrompt, reject);
        client.connect(handle.config);
      });

      this.shell = await new Promise<ClientChannel>((resolve, reject) => {
        client.shell(this.getShellOptions(), { env: this.getShellEnvironment() }, (error, stream) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stream);
        });
      });
    } catch (error) {
      client.end();
      handle.dispose();
      this.connectionHandle = undefined;
      throw error;
    }

    this.shell.on('data', (data: Buffer) => {
      this.events.output(data);
    });
    this.shell.on('close', () => {
      this.connected = false;
      this.events.status({ state: 'disconnected', text: t('Disconnected') });
    });
    this.connected = true;
    this.events.status({ state: 'connected', text: t('Connected') });
  }

  async reconnect(): Promise<void> {
    this.dispose();
    await this.connect();
  }

  write(data: string): void {
    this.shell?.write(data);
  }

  /**
   * Flow-control hooks for the terminal host's high-water mark: pausing the shell
   * channel makes the SSH window fill so the remote side stops sending. Both are
   * no-ops while no shell is open, so callers may invoke them at any point.
   */
  pauseOutput(): void {
    this.shell?.pause();
  }

  resumeOutput(): void {
    this.shell?.resume();
  }

  resize(rows: number, cols: number): void {
    if (rows > 0 && cols > 0) {
      this.rows = rows;
      this.cols = cols;
      this.shell?.setWindow(rows, cols, 0, 0);
    }
  }

  getShellOptions(): { term: string; rows: number; cols: number } {
    return {
      term: 'xterm-256color',
      rows: this.rows,
      cols: this.cols
    };
  }

  getShellEnvironment(): ShellOptions['env'] {
    return {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CLICOLOR: '1',
      FORCE_COLOR: '1'
    };
  }

  isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.shell?.end();
    this.client?.end();
    this.connectionHandle?.dispose();
    this.shell = undefined;
    this.client = undefined;
    this.connectionHandle = undefined;
    this.connected = false;
  }

  private async buildConnectionHandle(): Promise<SshConnectionHandle> {
    return buildSshConnectionHandle(this.server, this.configManager, this.hostKeyVerifier, {
      keyboardInteractivePrompt: this.keyboardInteractivePrompt
    });
  }
}
