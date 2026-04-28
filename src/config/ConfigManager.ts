import { parseServerConfig, parseServerConfigList, type ServerConfig } from './schema';

const SERVERS_KEY = 'sshManager.servers';
const PASSWORD_PREFIX = 'sshManager.password.';

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
    return parseServerConfigList(this.globalState.get<unknown[]>(SERVERS_KEY, []));
  }

  async getServer(id: string): Promise<ServerConfig | undefined> {
    return (await this.listServers()).find((server) => server.id === id);
  }

  async saveServer(server: ServerConfig, password?: string): Promise<void> {
    const parsed = parseServerConfig(server);
    const servers = await this.listServers();
    const next = [...servers.filter((entry) => entry.id !== parsed.id), parsed].sort((a, b) =>
      a.label.localeCompare(b.label)
    );
    await this.globalState.update(SERVERS_KEY, next);
    if (password !== undefined) {
      await this.secrets.store(this.passwordKey(parsed.id), password);
    }
  }

  async deleteServer(id: string): Promise<void> {
    const servers = await this.listServers();
    await this.globalState.update(
      SERVERS_KEY,
      servers.filter((server) => server.id !== id)
    );
    await this.secrets.delete(this.passwordKey(id));
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(this.passwordKey(id));
  }

  passwordKey(id: string): string {
    return `${PASSWORD_PREFIX}${id}`;
  }
}
