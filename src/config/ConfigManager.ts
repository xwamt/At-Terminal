import { parseServerConfig, parseServerConfigList, type ServerConfig } from './schema';

const SERVERS_KEY = 'sshManager.servers';
const PASSWORD_PREFIX = 'sshManager.password.';
const PASSPHRASE_PREFIX = 'sshManager.passphrase.';

export interface ExtensionMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface SecretStore {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export class ConfigManager {
  constructor(
    private readonly globalState: ExtensionMemento,
    private readonly secrets: SecretStore
  ) {}

  async listServers(): Promise<ServerConfig[]> {
    const raw = this.globalState.get<unknown>(SERVERS_KEY, []);
    const servers = parseServerConfigList(raw);
    // Persist migrated records (e.g. a backfilled encoding) so later reads see
    // the canonical shape. Writing only on an actual change avoids an update
    // on every list call. Never write back when parsing produced nothing from
    // a non-empty or non-array stored value: that would replace the user's
    // data with [] on a transient parse failure instead of leaving it intact
    // for a later, fixed read.
    const safeToPersist = Array.isArray(raw) && (servers.length > 0 || raw.length === 0);
    if (safeToPersist && JSON.stringify(servers) !== JSON.stringify(raw)) {
      await this.globalState.update(SERVERS_KEY, servers);
    }
    return servers;
  }

  async getServer(id: string): Promise<ServerConfig | undefined> {
    return (await this.listServers()).find((server) => server.id === id);
  }

  async findJumpHostReferences(id: string): Promise<ServerConfig[]> {
    return (await this.listServers()).filter((server) => server.jumpHostId === id);
  }

  async saveServer(server: ServerConfig, password?: string, passphrase?: string): Promise<void> {
    const parsed = parseServerConfig(server);
    const servers = await this.listServers();
    const next = [...servers.filter((entry) => entry.id !== parsed.id), parsed].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(SERVERS_KEY, next);
    if (password !== undefined) {
      await this.secrets.store(this.passwordKey(parsed.id), password);
    }
    if (passphrase !== undefined) {
      await this.secrets.store(this.passphraseKey(parsed.id), passphrase);
    }
  }

  async deleteServer(id: string): Promise<void> {
    const servers = await this.listServers();
    await this.globalState.update(
      SERVERS_KEY,
      servers.filter((server) => server.id !== id)
    );
    await this.secrets.delete(this.passwordKey(id));
    await this.secrets.delete(this.passphraseKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  async getPassphrase(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passphraseKey(id));
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }

  passphraseKey(id: string): string {
    return `${PASSPHRASE_PREFIX}${id}`;
  }
}
