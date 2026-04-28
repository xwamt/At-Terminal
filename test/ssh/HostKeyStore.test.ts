import { describe, expect, it } from 'vitest';
import { HostKeyStore, type HostKeyMemento } from '../../src/ssh/HostKeyStore';

class MemoryMemento implements HostKeyMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

describe('HostKeyStore', () => {
  it('returns unknown for an unseen host', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    expect(await store.check('example.com', 22, 'SHA256:abc')).toBe('unknown');
  });

  it('trusts a host and returns trusted for the same fingerprint', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'SHA256:abc', 'ssh-ed25519');
    expect(await store.check('example.com', 22, 'SHA256:abc')).toBe('trusted');
  });

  it('returns changed when a trusted fingerprint differs', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'SHA256:abc', 'ssh-ed25519');
    expect(await store.check('example.com', 22, 'SHA256:def')).toBe('changed');
  });
});
