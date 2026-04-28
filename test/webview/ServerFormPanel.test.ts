import { describe, expect, it, vi } from 'vitest';
import { handleServerFormMessage } from '../../src/webview/ServerFormPanel';

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
});
