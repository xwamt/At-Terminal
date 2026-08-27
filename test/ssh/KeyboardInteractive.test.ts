import { describe, expect, it, vi } from 'vitest';
import { attachKeyboardInteractive } from '../../src/ssh/KeyboardInteractive';

type Listener = (
  name: string,
  instructions: string,
  lang: string,
  prompts: Array<{ prompt: string; echo?: boolean }>,
  finish: (responses: string[]) => void
) => void;

function fakeClient(): {
  client: { on: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  trigger: Listener;
} {
  let listener: Listener | undefined;
  const client = {
    on: vi.fn((_event: string, handler: Listener) => {
      listener = handler;
      return client;
    }),
    end: vi.fn()
  };
  return {
    client,
    trigger: (...args) => listener?.(...args)
  };
}

describe('attachKeyboardInteractive', () => {
  it('finishes the round with the prompt answers', async () => {
    const { client, trigger } = fakeClient();
    const onAbort = vi.fn();
    const finish = vi.fn();
    const prompt = vi.fn(async () => ['123456', 'yubikey']);

    attachKeyboardInteractive(client, prompt, onAbort);
    trigger('2FA', 'Enter your codes', 'en', [
      { prompt: 'Code:', echo: false },
      { prompt: 'Token:', echo: true }
    ], finish);
    await vi.waitFor(() => expect(finish).toHaveBeenCalledWith(['123456', 'yubikey']));

    expect(prompt).toHaveBeenCalledWith({
      name: '2FA',
      instructions: 'Enter your codes',
      prompts: [
        { prompt: 'Code:', echo: false },
        { prompt: 'Token:', echo: true }
      ]
    });
    expect(onAbort).not.toHaveBeenCalled();
    expect(client.end).not.toHaveBeenCalled();
  });

  it('aborts with a clear error when no prompt is available', () => {
    const { client, trigger } = fakeClient();
    const onAbort = vi.fn();
    const finish = vi.fn();

    attachKeyboardInteractive(client, undefined, onAbort);
    trigger('2FA', '', 'en', [{ prompt: 'Code:', echo: false }], finish);

    expect(onAbort).toHaveBeenCalledWith(
      new Error(
        'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
      )
    );
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it('aborts when the user cancels the prompt', async () => {
    const { client, trigger } = fakeClient();
    const onAbort = vi.fn();
    const finish = vi.fn();

    attachKeyboardInteractive(client, async () => undefined, onAbort);
    trigger('2FA', '', 'en', [{ prompt: 'Code:', echo: false }], finish);
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalled());

    expect(onAbort).toHaveBeenCalledWith(new Error('Keyboard-interactive authentication was cancelled.'));
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });

  it('aborts with the prompt failure when the prompt itself throws', async () => {
    const { client, trigger } = fakeClient();
    const onAbort = vi.fn();

    attachKeyboardInteractive(client, async () => {
      throw new Error('input box exploded');
    }, onAbort);
    trigger('2FA', '', 'en', [{ prompt: 'Code:', echo: false }], vi.fn());
    await vi.waitFor(() => expect(onAbort).toHaveBeenCalled());

    expect(onAbort).toHaveBeenCalledWith(new Error('input box exploded'));
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
