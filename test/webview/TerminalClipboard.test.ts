import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalKeyboardHandler,
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
  private readonly listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
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

  it('lets xterm handle Ctrl+V paste input so pasted text is sent only once', async () => {
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
});

describe('terminal focus recovery', () => {
  it('refocuses xterm after context-menu copy and paste actions', () => {
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

    expect(focus).toHaveBeenCalledTimes(3);
  });
});

describe('terminal status classes', () => {
  it('treats idle disconnect messages as disconnected status', () => {
    expect(resolveTerminalStatusClass('AT Terminal disconnected after 1 minute(s) of inactivity.')).toBe(
      'disconnected'
    );
  });
});
