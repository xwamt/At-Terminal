import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalKeyboardHandler,
  installTerminalClipboardPasteHandler,
  installTerminalFocusRecovery,
  resolveTerminalStatusClass,
  type TerminalClipboard
} from '../../webview/terminal/clipboard';

function keyEvent(key: string): KeyboardEvent {
  return {
    type: 'keydown',
    key,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  } as unknown as KeyboardEvent;
}

class FakeEventTarget {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  fire(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function pasteEvent(text: string) {
  return {
    clipboardData: {
      getData: vi.fn((type: string) => (type === 'text/plain' ? text : ''))
    },
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  };
}

async function flushClipboardPromise(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('terminal clipboard shortcuts', () => {
  it('copies the current xterm selection on Ctrl+C without sending interrupt input', async () => {
    const clipboard: TerminalClipboard = {
      readText: vi.fn(),
      writeText: vi.fn(async () => undefined)
    };
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => true,
        getSelection: () => 'selected text',
        clearSelection: vi.fn(),
        focus: vi.fn(),
        paste: vi.fn()
      },
      { clipboard, sendInput }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith('selected text');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('sends the terminal interrupt byte on a single Ctrl+C when there is no selection', () => {
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => false,
        getSelection: () => '',
        clearSelection: vi.fn(),
        focus: vi.fn(),
        paste: vi.fn()
      },
      {
        clipboard: { readText: vi.fn(), writeText: vi.fn() },
        sendInput
      }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    expect(sendInput).toHaveBeenCalledWith('\x03');
  });

  it('pastes Ctrl+V through the terminal paste API when the xterm input is focused', async () => {
    const sendInput = vi.fn();
    const readText = vi.fn(async () => 'pasted text');
    const event = keyEvent('v');
    const terminal = {
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: vi.fn(),
      focus: vi.fn(),
      paste: vi.fn()
    };
    const handler = createTerminalKeyboardHandler(
      terminal,
      {
        clipboard: {
          readText,
          writeText: vi.fn()
        },
        sendInput
      }
    );

    expect(handler(event)).toBe(false);
    await flushClipboardPromise();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('pasted text');
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('keeps focus and does not send input when Ctrl+V clipboard access fails', async () => {
    const sendInput = vi.fn();
    const event = keyEvent('v');
    const terminal = {
      hasSelection: () => false,
      getSelection: () => '',
      clearSelection: vi.fn(),
      focus: vi.fn(),
      paste: vi.fn()
    };
    const handler = createTerminalKeyboardHandler(
      terminal,
      {
        clipboard: {
          readText: vi.fn(async () => {
            throw new Error('clipboard denied');
          }),
          writeText: vi.fn()
        },
        sendInput
      }
    );

    expect(handler(event)).toBe(false);
    await flushClipboardPromise();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(terminal.paste).not.toHaveBeenCalled();
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('pastes from the browser paste event so focused xterm input still pastes once', () => {
    const target = new FakeEventTarget();
    const terminal = {
      paste: vi.fn(),
      focus: vi.fn()
    };
    const event = pasteEvent('pasted text');

    installTerminalClipboardPasteHandler(terminal, target as never);
    target.fire('paste', event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith('pasted text');
    expect(terminal.focus).toHaveBeenCalledOnce();
  });
});

describe('terminal focus recovery', () => {
  it('refocuses xterm after copy and paste actions without stealing context-menu focus', () => {
    const container = new FakeEventTarget();
    const document = new FakeEventTarget();
    const focus = vi.fn();
    const timers: Array<() => void> = [];

    installTerminalFocusRecovery(
      {
        focus
      },
      {
        container: container as never,
        document: document as never,
        setTimeout: (callback) => {
          timers.push(callback);
          return timers.length;
        }
      }
    );

    container.fire('contextmenu');
    document.fire('copy');
    document.fire('paste');
    for (const timer of timers) {
      timer();
    }

    expect(focus).toHaveBeenCalledTimes(2);
  });
});

describe('terminal status classes', () => {
  it('treats idle disconnect messages as disconnected status', () => {
    expect(resolveTerminalStatusClass('AT Terminal disconnected after 1 minute(s) of inactivity.')).toBe(
      'disconnected'
    );
  });

  it('treats plain disconnect notices as disconnected status', () => {
    expect(resolveTerminalStatusClass('Disconnected after 30 minute(s) of inactivity.')).toBe('disconnected');
  });
});
