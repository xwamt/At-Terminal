import { Client, type ClientChannel, type ShellOptions } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { buildSshConnectConfig, type HostKeyVerifier } from './SshConnectionConfig';

export interface SshSessionEvents {
  output(data: Buffer): void;
  status(message: string): void;
  error(error: unknown): void;
}

export class SshSession {
  private client: Client | undefined;
  private shell: ClientChannel | undefined;
  private rows = 24;
  private cols = 80;
  private connected = false;

  constructor(
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly events: SshSessionEvents,
    private readonly hostKeyVerifier?: HostKeyVerifier
  ) {}

  async connect(): Promise<void> {
    this.events.status(`Connecting to ${this.server.host}:${this.server.port}...`);
    const config = await this.buildConnectConfig();
    const client = new Client();
    this.client = client;

    await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.connect(config);
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

    this.shell.on('data', (data: Buffer) => {
      this.events.output(data);
    });
    this.shell.on('close', () => {
      this.connected = false;
      this.events.status('Disconnected');
    });
    this.connected = true;
    this.events.status('Connected');
  }

  async reconnect(): Promise<void> {
    this.dispose();
    await this.connect();
  }

  write(data: string): void {
    this.shell?.write(data);
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
    this.shell = undefined;
    this.client = undefined;
    this.connected = false;
  }

  private async buildConnectConfig() {
    return buildSshConnectConfig(this.server, this.configManager, this.hostKeyVerifier);
  }
}
