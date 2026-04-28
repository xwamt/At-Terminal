const HOST_KEYS_KEY = 'sshManager.trustedHostKeys';

export type HostKeyStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedHostKey {
  host: string;
  port: number;
  fingerprint: string;
  algorithm?: string;
  trustedAt: number;
}

export interface HostKeyMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export class HostKeyStore {
  constructor(private readonly globalState: HostKeyMemento) {}

  async check(host: string, port: number, fingerprint: string): Promise<HostKeyStatus> {
    const keys = this.read();
    const existing = keys[this.key(host, port)];
    if (!existing) {
      return 'unknown';
    }
    return existing.fingerprint === fingerprint ? 'trusted' : 'changed';
  }

  async trust(host: string, port: number, fingerprint: string, algorithm?: string): Promise<void> {
    const keys = this.read();
    keys[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      algorithm,
      trustedAt: Date.now()
    };
    await this.globalState.update(HOST_KEYS_KEY, keys);
  }

  getTrusted(host: string, port: number): TrustedHostKey | undefined {
    return this.read()[this.key(host, port)];
  }

  private read(): Record<string, TrustedHostKey> {
    return this.globalState.get<Record<string, TrustedHostKey>>(HOST_KEYS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
