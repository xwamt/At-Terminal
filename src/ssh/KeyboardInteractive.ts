export interface KeyboardInteractivePromptField {
  prompt: string;
  /** False for secrets such as verification codes; the UI must mask the input. */
  echo: boolean;
}

export interface KeyboardInteractiveRequest {
  name: string;
  instructions: string;
  prompts: KeyboardInteractivePromptField[];
}

/**
 * Answers a keyboard-interactive round (2FA codes, PAM prompts). Resolves the answers
 * in prompt order, or `undefined` when the user cancelled. Kept as a plain callback so
 * the ssh layer stays UI-agnostic; the VS Code InputBox adapter lives in
 * VscodeKeyboardInteractivePrompt.ts.
 */
export type KeyboardInteractivePrompt = (
  request: KeyboardInteractiveRequest
) => Promise<string[] | undefined>;

/**
 * Structural subset of ssh2's Client, so tests and non-Client doubles can be used.
 * `on` is optional because some existing test doubles only implement `once`; a client
 * that cannot register the listener simply gets no keyboard-interactive support and
 * fails at ssh2's ready timeout instead. Real ssh2 Clients always have `on`.
 */
export interface KeyboardInteractiveClient {
  on?(
    event: 'keyboard-interactive',
    listener: (
      name: string,
      instructions: string,
      lang: string,
      prompts: Array<{ prompt: string; echo?: boolean }>,
      finish: (responses: string[]) => void
    ) => void
  ): unknown;
  end(): unknown;
}

/**
 * Wires a client for `tryKeyboard: true`. Without a listener ssh2 never answers the
 * server's USERAUTH_INFO_REQUEST and the handshake stalls until the ready timeout, so
 * every connect path attaches this. A missing prompt (background/no-UI contexts) or a
 * cancelled prompt aborts the connection through `onAbort` with a clear error instead
 * of hanging.
 */
export function attachKeyboardInteractive(
  client: KeyboardInteractiveClient,
  prompt: KeyboardInteractivePrompt | undefined,
  onAbort: (error: Error) => void
): void {
  client.on?.('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
    const abort = (error: Error): void => {
      onAbort(error);
      // Tear the handshake down; otherwise ssh2 keeps waiting for responses.
      client.end();
    };

    if (!prompt) {
      abort(
        new Error(
          'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
        )
      );
      return;
    }

    const request: KeyboardInteractiveRequest = {
      name,
      instructions,
      prompts: prompts.map((entry) => ({ prompt: entry.prompt, echo: Boolean(entry.echo) }))
    };

    void prompt(request).then(
      (responses) => {
        if (!responses) {
          abort(new Error('Keyboard-interactive authentication was cancelled.'));
          return;
        }
        finish(responses);
      },
      (error) => {
        abort(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}
