import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel, type ConnectConfig, type VerifyCallback } from 'ssh2';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';

export interface SshSessionEvents {
  output(data: string): void;
  status(message: string): void;
  error(error: unknown): void;
}

export interface HostKeyVerifier {
  verify(host: string, port: number, hashedKey: string): Promise<boolean>;
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
      client.shell(this.getShellOptions(), (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stream);
      });
    });

    this.shell.on('data', (data: Buffer) => {
      this.events.output(data.toString(this.server.encoding));
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

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const base: ConnectConfig = {
      host: this.server.host,
      port: this.server.port,
      username: this.server.username,
      keepaliveInterval: this.server.keepAliveInterval * 1000,
      hostHash: 'sha256',
      hostVerifier: this.createHostVerifier()
    };

    if (this.server.authType === 'password') {
      const password = await this.configManager.getPassword(this.server.id);
      if (!password) {
        throw new Error('Missing password. Edit the server configuration and enter a password.');
      }
      return { ...base, password };
    }

    if (!this.server.privateKeyPath) {
      throw new Error('Missing private key path.');
    }
    return {
      ...base,
      privateKey: await readFile(this.server.privateKeyPath, 'utf8')
    };
  }

  private createHostVerifier(): ConnectConfig['hostVerifier'] {
    if (!this.hostKeyVerifier) {
      return undefined;
    }

    const verifyHost = (fingerprint: string, verify: VerifyCallback): void => {
      void this.hostKeyVerifier!.verify(this.server.host, this.server.port, fingerprint).then(
        verify,
        () => verify(false)
      );
    };

    return verifyHost as ConnectConfig['hostVerifier'];
  }
}
