import { describe, expect, it, vi } from 'vitest';
import {
  applyTerminalZebraRows,
  scheduleTerminalZebraRefresh,
  TERMINAL_ROW_EVEN_CLASS,
  TERMINAL_ROW_ODD_CLASS
} from '../../webview/terminal/zebra';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.add(token);
    }
  }

  remove(...tokens: string[]): void {
    for (const token of tokens) {
      this.values.delete(token);
    }
  }

  has(token: string): boolean {
    return this.values.has(token);
  }
}

function fakeRow() {
  return { classList: new FakeClassList() };
}

describe('terminal zebra striping', () => {
  it('assigns alternating row classes and removes stale stripe classes', () => {
    const rows = [fakeRow(), fakeRow(), fakeRow()];
    rows[0].classList.add(TERMINAL_ROW_ODD_CLASS);
    rows[1].classList.add(TERMINAL_ROW_EVEN_CLASS);

    applyTerminalZebraRows(rows);

    expect(rows[0].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(true);
    expect(rows[0].classList.has(TERMINAL_ROW_ODD_CLASS)).toBe(false);
    expect(rows[1].classList.has(TERMINAL_ROW_ODD_CLASS)).toBe(true);
    expect(rows[1].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(false);
    expect(rows[2].classList.has(TERMINAL_ROW_EVEN_CLASS)).toBe(true);
  });

  it('coalesces repeated write-parsed notifications into one stripe refresh per frame', () => {
    const refresh = vi.fn();
    let listener!: () => void;
    const terminal = {
      onWriteParsed(callback: () => void) {
        listener = callback;
        return { dispose: vi.fn() };
      }
    };
    const frames: Array<FrameRequestCallback> = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });

    scheduleTerminalZebraRefresh(terminal, refresh, requestFrame);
    listener();
    listener();

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    frames[0](0);

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
