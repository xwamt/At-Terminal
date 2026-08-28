import { describe, expect, it } from 'vitest';
import { ConfigManager, type ExtensionMemento, type SecretStore } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';

class MemoryMemento implements ExtensionMemento {
  private data = new Map<string, unknown>();
  updateCalls = 0;

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.updateCalls += 1;
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

  it('stores and returns private key passphrases outside the config', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);
    const keyServer = server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' });

    await manager.saveServer(keyServer, undefined, 'key-passphrase');

    expect(await manager.listServers()).toEqual([keyServer]);
    expect(await manager.getPassphrase('server-1')).toBe('key-passphrase');
    expect(secrets.data.get('sshManager.passphrase.server-1')).toBe('key-passphrase');
    expect(await manager.getPassword('server-1')).toBeUndefined();
  });

  it('keeps an existing passphrase when saving without one', async () => {
    const manager = new ConfigManager(new MemoryMemento(), new MemorySecretStore());
    const keyServer = server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' });

    await manager.saveServer(keyServer, undefined, 'key-passphrase');
    await manager.saveServer({ ...keyServer, label: 'Renamed', updatedAt: 2 });

    expect(await manager.getPassphrase('server-1')).toBe('key-passphrase');
  });

  it('deletes the passphrase together with the server', async () => {
    const secrets = new MemorySecretStore();
    const manager = new ConfigManager(new MemoryMemento(), secrets);

    await manager.saveServer(
      server({ authType: 'privateKey', privateKeyPath: 'C:/keys/prod.pem' }),
      undefined,
      'key-passphrase'
    );
    await manager.deleteServer('server-1');

    expect(await manager.getPassphrase('server-1')).toBeUndefined();
    expect(secrets.data.size).toBe(0);
  });

  it('lists legacy records saved before the encoding field existed', async () => {
    const memento = new MemoryMemento();
    const legacy = { ...server() } as Record<string, unknown>;
    delete legacy.encoding;
    await memento.update('sshManager.servers', [legacy]);
    const manager = new ConfigManager(memento, new MemorySecretStore());

    const listed = await manager.listServers();

    expect(listed).toHaveLength(1);
    expect(listed[0].encoding).toBe('utf-8');
  });

  it('keeps valid servers when the stored list also holds an unreadable record', async () => {
    const memento = new MemoryMemento();
    await memento.update('sshManager.servers', [server(), { junk: true }]);
    const manager = new ConfigManager(memento, new MemorySecretStore());

    expect((await manager.listServers()).map((entry) => entry.id)).toEqual(['server-1']);
  });

  it('does not write back when a record fails migration, so the raw data survives', async () => {
    const good = server({ id: 'a' });
    const corrupt = { ...server({ id: 'b' }), keepAliveInterval: 'thirty' };
    const stored = [good, corrupt];
    const memento = new MemoryMemento();
    await memento.update('sshManager.servers', stored);
    const manager = new ConfigManager(memento, new MemorySecretStore());
    const updatesBefore = memento.updateCalls;

    const servers = await manager.listServers();

    expect(servers.map((entry) => entry.id)).toEqual(['a']);
    expect(memento.updateCalls).toBe(updatesBefore);
    expect(memento.get<unknown[]>('sshManager.servers', [])).toHaveLength(2);
  });

  it('never persists an empty list over stored records that all failed to parse', async () => {
    const memento = new MemoryMemento();
    const unreadable = [{ junk: true }, { alsoJunk: 1 }];
    await memento.update('sshManager.servers', unreadable);
    const manager = new ConfigManager(memento, new MemorySecretStore());
    const updatesBefore = memento.updateCalls;

    expect(await manager.listServers()).toEqual([]);

    expect(memento.updateCalls).toBe(updatesBefore);
    expect(memento.get<unknown[]>('sshManager.servers', [])).toEqual(unreadable);
  });

  it('does not wipe a corrupt non-array stored value', async () => {
    const memento = new MemoryMemento();
    await memento.update('sshManager.servers', { corrupt: 'not-an-array' });
    const manager = new ConfigManager(memento, new MemorySecretStore());
    const updatesBefore = memento.updateCalls;

    expect(await manager.listServers()).toEqual([]);

    expect(memento.updateCalls).toBe(updatesBefore);
    expect(memento.get<unknown>('sshManager.servers', [])).toEqual({ corrupt: 'not-an-array' });
  });

  it('persists the migrated list once and stops rewriting after that', async () => {
    const memento = new MemoryMemento();
    const legacy = { ...server(), legacyFlag: true } as Record<string, unknown>;
    delete legacy.encoding;
    await memento.update('sshManager.servers', [legacy]);
    const manager = new ConfigManager(memento, new MemorySecretStore());
    const updatesBefore = memento.updateCalls;

    await manager.listServers();
    expect(memento.updateCalls).toBe(updatesBefore + 1);
    expect(memento.get<unknown[]>('sshManager.servers', [])).toEqual([server()]);

    await manager.listServers();
    expect(memento.updateCalls).toBe(updatesBefore + 1);
  });

  it('finds servers that reference a jump host', async () => {
    const manager = new ConfigManager(new MemoryMemento(), new MemorySecretStore());

    await manager.saveServer(server({ id: 'jump-1', label: 'Bastion', host: 'bastion.example.com' }));
    await manager.saveServer(server({ id: 'app-1', label: 'App One', jumpHostId: 'jump-1' }));
    await manager.saveServer(server({ id: 'app-2', label: 'App Two', jumpHostId: 'jump-1' }));
    await manager.saveServer(server({ id: 'direct-1', label: 'Direct' }));

    expect(await manager.findJumpHostReferences('jump-1')).toEqual([
      expect.objectContaining({ id: 'app-1', label: 'App One' }),
      expect.objectContaining({ id: 'app-2', label: 'App Two' })
    ]);
  });
});
