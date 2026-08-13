export const TERMINAL_OUTPUT_FLUSH_MS = 8;
export const TERMINAL_OUTPUT_FLUSH_BYTES = 64 * 1024;

export interface TerminalOutputBatcherOptions {
  emit(payload: string): void;
  flushIntervalMs?: number;
  flushBytes?: number;
}

/**
 * Coalesces SSH output packets into one webview message per frame budget. Without this a
 * busy remote command posts one `postMessage` per TCP packet, and the structured clone of
 * each message competes with xterm rendering on the same thread.
 */
export class TerminalOutputBatcher {
  private readonly emit: (payload: string) => void;
  private readonly flushIntervalMs: number;
  private readonly flushBytes: number;
  private chunks: Buffer[] = [];
  private pendingBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: TerminalOutputBatcherOptions) {
    this.emit = options.emit;
    this.flushIntervalMs = options.flushIntervalMs ?? TERMINAL_OUTPUT_FLUSH_MS;
    this.flushBytes = options.flushBytes ?? TERMINAL_OUTPUT_FLUSH_BYTES;
  }

  push(chunk: Buffer): void {
    if (chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.pendingBytes += chunk.byteLength;
    if (this.pendingBytes >= this.flushBytes) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), this.flushIntervalMs);
  }

  flush(): void {
    this.clearTimer();
    if (this.pendingBytes === 0) {
      return;
    }
    const payload = (this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.pendingBytes)).toString(
      'base64'
    );
    this.chunks = [];
    this.pendingBytes = 0;
    this.emit(payload);
  }

  dispose(): void {
    this.flush();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
