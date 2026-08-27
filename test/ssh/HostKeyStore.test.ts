import { describe, expect, it } from 'vitest';
import { formatFingerprint, HostKeyStore, type HostKeyMemento } from '../../src/ssh/HostKeyStore';

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

  it('forgets a trusted host key by host and port', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'SHA256:abc', 'ssh-ed25519');
    await store.forget('example.com', 22);
    expect(await store.check('example.com', 22, 'SHA256:def')).toBe('unknown');
  });

  it('describes a trusted host key for display', async () => {
    const store = new HostKeyStore(new MemoryMemento());
    await store.trust('example.com', 22, 'abcdef123456', 'ssh-ed25519');

    const description = store.describe('example.com', 22);

    expect(description).toContain('example.com:22');
    expect(description).toContain('SHA256:abcdef123456');
    expect(description).toContain('(ssh-ed25519)');
  });

  it('returns undefined when describing a host with no trusted key', () => {
    const store = new HostKeyStore(new MemoryMemento());
    expect(store.describe('example.com', 22)).toBeUndefined();
  });
});

describe('formatFingerprint', () => {
  it('prefixes bare sha256 digests OpenSSH-style', () => {
    expect(formatFingerprint('abcdef123456')).toBe('SHA256:abcdef123456');
  });

  it('keeps values that already carry a hash label', () => {
    expect(formatFingerprint('SHA256:abcdef123456')).toBe('SHA256:abcdef123456');
    expect(formatFingerprint('MD5:aa:bb:cc')).toBe('MD5:aa:bb:cc');
  });
});
