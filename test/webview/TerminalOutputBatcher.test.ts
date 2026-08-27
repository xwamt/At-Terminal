import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TERMINAL_OUTPUT_FLUSH_BYTES,
  TERMINAL_OUTPUT_FLUSH_MS,
  TerminalOutputBatcher
} from '../../src/webview/TerminalOutputBatcher';

afterEach(() => {
  vi.useRealTimers();
});

function text(payload: Uint8Array): string {
  return Buffer.from(payload).toString();
}

describe('TerminalOutputBatcher', () => {
  it('coalesces chunks that arrive inside the flush window into one binary payload', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    batcher.push(Buffer.from('one '));
    batcher.push(Buffer.from('two '));
    batcher.push(Buffer.from('three'));
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

    expect(emitted).toHaveLength(1);
    expect(text(emitted[0])).toBe('one two three');
  });

  it('emits a plain Uint8Array rather than a base64 string or pooled Node Buffer', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    batcher.push(Buffer.from('payload'));
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

    expect(emitted[0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(emitted[0])).toBe(false);
    // A standalone copy: no view into a larger pooled allocation crosses postMessage.
    expect(emitted[0].byteOffset).toBe(0);
    expect(emitted[0].buffer.byteLength).toBe(emitted[0].byteLength);
  });

  it('flushes immediately once pending output reaches the byte threshold', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    batcher.push(Buffer.alloc(TERMINAL_OUTPUT_FLUSH_BYTES, 0x61));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].byteLength).toBe(TERMINAL_OUTPUT_FLUSH_BYTES);
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toHaveLength(1);
  });

  it('keeps binary bytes intact instead of losing them to text decoding', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });
    const raw = Buffer.from([0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xff, 0xfe, 0x80]);

    batcher.push(raw);
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

    expect(Buffer.from(emitted[0]).equals(raw)).toBe(true);
  });

  it('flushes buffered output on dispose so it cannot arrive after a disconnect notice', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    batcher.push(Buffer.from('tail'));
    batcher.dispose();

    expect(emitted).toHaveLength(1);
    expect(text(emitted[0])).toBe('tail');
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);
    expect(emitted).toHaveLength(1);
  });

  it('emits nothing when disposed with no pending output', () => {
    const emit = vi.fn();
    const batcher = new TerminalOutputBatcher({ emit });

    batcher.dispose();

    expect(emit).not.toHaveBeenCalled();
  });

  it('starts a new flush window after a flush instead of dropping later output', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    batcher.push(Buffer.from('first'));
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);
    batcher.push(Buffer.from('second'));
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

    expect(emitted.map(text)).toEqual(['first', 'second']);
  });

  it('coalesces an 8ms burst of SSH packets into a single webview message', () => {
    vi.useFakeTimers();
    const emitted: Uint8Array[] = [];
    const batcher = new TerminalOutputBatcher({ emit: (payload) => emitted.push(payload) });

    for (let packet = 0; packet < 64; packet += 1) {
      batcher.push(Buffer.alloc(512, 0x62));
    }
    vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].byteLength).toBe(64 * 512);
  });
});
