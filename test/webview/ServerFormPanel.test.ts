import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { handleServerFormMessage } from '../../src/webview/ServerFormPanel';

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

describe('ServerFormPanel message handling', () => {
  it('posts schema errors back into the form webview', async () => {
    const postMessage = vi.fn();
    const saveServer = vi.fn();

    const handled = await handleServerFormMessage(
      {
        type: 'submit',
        payload: {
          label: '',
          host: '',
          port: 22,
          username: '',
          authType: 'password',
          keepAliveInterval: 30
        }
      },
      undefined,
      { saveServer } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never
    );

    expect(handled).toBe(true);
    expect(saveServer).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'error',
      payload: expect.stringContaining('label')
    });
  });

  it('posts a selected private key path back to the form webview', async () => {
    const postMessage = vi.fn();
    const selectPrivateKey = vi.fn(async () => [{ fsPath: 'C:\\Users\\alan\\.ssh\\id_ed25519' }]);

    const handled = await handleServerFormMessage(
      { type: 'selectPrivateKey' },
      undefined,
      { saveServer: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never,
      { selectPrivateKey }
    );

    expect(handled).toBe(true);
    expect(selectPrivateKey).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'privateKeySelected',
      payload: { path: 'C:\\Users\\alan\\.ssh\\id_ed25519' }
    });
  });

  it('posts a cancellation message when private key selection is cancelled', async () => {
    const postMessage = vi.fn();
    const selectPrivateKey = vi.fn(async () => undefined);

    const handled = await handleServerFormMessage(
      { type: 'selectPrivateKey' },
      undefined,
      { saveServer: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never,
      { selectPrivateKey }
    );

    expect(handled).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ type: 'privateKeySelectionCancelled' });
  });

  it('requires a password when adding a password-auth server', async () => {
    const postMessage = vi.fn();
    const saveServer = vi.fn();

    const handled = await handleServerFormMessage(
      {
        type: 'submit',
        payload: {
          label: 'Production',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          authType: 'password',
          password: '',
          keepAliveInterval: 30
        }
      },
      undefined,
      { saveServer } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never
    );

    expect(handled).toBe(true);
    expect(saveServer).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'error',
      payload: 'Password is required for new password-auth servers.'
    });
  });

  it('does not overwrite an existing password when editing with a blank password', async () => {
    const saveServer = vi.fn();

    const handled = await handleServerFormMessage(
      {
        type: 'submit',
        payload: {
          label: 'Production',
          group: 'prod',
          host: 'example.com',
          port: 22,
          username: 'deploy',
          authType: 'password',
          password: '',
          keepAliveInterval: 30
        }
      },
      server(),
      { saveServer } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
    );

    expect(handled).toBe(true);
    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), undefined);
  });
});
