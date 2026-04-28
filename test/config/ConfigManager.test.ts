import { describe, expect, it } from 'vitest';
import { ConfigManager, type ExtensionMemento, type SecretStore } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';

class MemoryMemento implements ExtensionMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      this.data.set(key, value);
    }
  }
}

class MemorySecretStore implements SecretStore {
  data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    group: 'prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

describe('ConfigManager', () => {
  it('creates and lists servers without storing passwords in config', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);

    await manager.saveServer(server(), 'super-secret');

    expect(await manager.listServers()).toEqual([server()]);
    expect(await manager.getPassword('server-1')).toBe('super-secret');
  });

  it('updates existing servers by id', async () => {
    const manager = new ConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveServer(server());
    await manager.saveServer(server({ label: 'Renamed', updatedAt: 2 }));

    expect((await manager.getServer('server-1'))?.label).toBe('Renamed');
  });

  it('deletes server config and password', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);

    await manager.saveServer(server(), 'super-secret');
    await manager.deleteServer('server-1');

    expect(await manager.listServers()).toEqual([]);
    expect(await manager.getPassword('server-1')).toBeUndefined();
  });
});
