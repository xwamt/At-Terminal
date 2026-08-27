import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { promptChangedHostKey, serverConnectionStates } from '../../src/extension';
import type { TrustedHostKey } from '../../src/ssh/HostKeyStore';

function hostKeyStoreMock(stored?: Partial<TrustedHostKey>) {
  return {
    trust: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    getTrusted: vi.fn(() =>
      stored
        ? ({ host: 'example.com', port: 22, fingerprint: 'aa:bb', trustedAt: 1, ...stored } as TrustedHostKey)
        : undefined
    )
  };
}

describe('promptChangedHostKey', () => {
  beforeEach(() => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'withProgress').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks the connection when the persistent error is dismissed', async () => {
    const store = hostKeyStoreMock({ fingerprint: 'aa:bb' });
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined as never);

    await expect(promptChangedHostKey('example.com', 22, 'cc:dd', store)).resolves.toBe(false);

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Host key for example.com:22 changed'),
      'View Fingerprint',
      'Trust New Key',
      'Forget and Reconnect'
    );
    expect(store.trust).not.toHaveBeenCalled();
    expect(store.forget).not.toHaveBeenCalled();
  });

  it('trusts the new fingerprint and allows the connection when the user picks Trust New Key', async () => {
    const store = hostKeyStoreMock({ fingerprint: 'aa:bb' });
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Trust New Key' as never);

    await expect(promptChangedHostKey('example.com', 22, 'cc:dd', store)).resolves.toBe(true);

    expect(store.trust).toHaveBeenCalledWith('example.com', 22, 'cc:dd');
    expect(store.forget).not.toHaveBeenCalled();
  });

  it('forgets the stored key and still blocks this attempt when the user picks Forget and Reconnect', async () => {
    const store = hostKeyStoreMock({ fingerprint: 'aa:bb' });
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Forget and Reconnect' as never);

    await expect(promptChangedHostKey('example.com', 22, 'cc:dd', store)).resolves.toBe(false);

    expect(store.forget).toHaveBeenCalledWith('example.com', 22);
    expect(store.trust).not.toHaveBeenCalled();
  });

  it('shows the stored fingerprint on View Fingerprint and asks again', async () => {
    const store = hostKeyStoreMock({ fingerprint: 'aa:bb' });
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValueOnce('View Fingerprint' as never)
      .mockResolvedValueOnce('Trust New Key' as never);

    await expect(promptChangedHostKey('example.com', 22, 'cc:dd', store)).resolves.toBe(true);

    expect(store.getTrusted).toHaveBeenCalledWith('example.com', 22);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Stored fingerprint for example.com:22: aa:bb'
    );
    expect(showErrorMessage).toHaveBeenCalledTimes(2);
    expect(store.trust).toHaveBeenCalledWith('example.com', 22, 'cc:dd');
  });
});

describe('serverConnectionStates', () => {
  it('prefers connected over disconnected terminals for the same server', () => {
    const states = serverConnectionStates([
      { serverId: 'a', connected: false },
      { serverId: 'a', connected: true },
      { serverId: 'b', connected: true },
      { serverId: 'b', connected: false },
      { serverId: 'c', connected: false }
    ]);

    expect(states.get('a')).toBe('connected');
    expect(states.get('b')).toBe('connected');
    expect(states.get('c')).toBe('disconnected');
    expect(states.has('d')).toBe(false);
  });
});
