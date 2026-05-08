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
    shiftKey: false
  } as KeyboardEvent;
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
        focus: vi.fn()
      },
      { clipboard, sendInput }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    await Promise.resolve();

    expect(clipboard.writeText).toHaveBeenCalledWith('selected text');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('requires two Ctrl+C presses before sending the terminal interrupt byte', () => {
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_500);
    const sendInput = vi.fn();
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => false,
        getSelection: () => '',
        clearSelection: vi.fn(),
        focus: vi.fn()
      },
      {
        clipboard: { readText: vi.fn(), writeText: vi.fn() },
        sendInput,
        now
      }
    );

    expect(handler(keyEvent('c'))).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();

    expect(handler(keyEvent('c'))).toBe(false);
    expect(sendInput).toHaveBeenCalledWith('\x03');
  });

  it('does not send input from Ctrl+V keydown before the browser paste event arrives', async () => {
    const sendInput = vi.fn();
    const readText = vi.fn(async () => 'pasted text');
    const handler = createTerminalKeyboardHandler(
      {
        hasSelection: () => false,
        getSelection: () => '',
        clearSelection: vi.fn(),
        focus: vi.fn()
      },
      {
        clipboard: {
          readText,
          writeText: vi.fn()
        },
        sendInput
      }
    );

    expect(handler(keyEvent('v'))).toBe(true);
    await Promise.resolve();

    expect(readText).not.toHaveBeenCalled();
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

  it('treats Chinese disconnect messages as disconnected status', () => {
    expect(resolveTerminalStatusClass('空闲时间超过30分钟，断开连接')).toBe('disconnected');
  });
});
