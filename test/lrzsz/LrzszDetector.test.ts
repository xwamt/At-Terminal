import { describe, expect, it, vi } from 'vitest';
import { LrzszDetector } from '../../src/lrzsz/LrzszDetector';

describe('LrzszDetector', () => {
  it('passes normal terminal output through', () => {
    const detector = new LrzszDetector({ onTransfer: vi.fn() });
    expect(detector.inspect('hello\r\n')).toEqual({ passthrough: 'hello\r\n' });
  });

  it('detects a ZMODEM receive sequence conservatively', () => {
    const onTransfer = vi.fn();
    const detector = new LrzszDetector({ onTransfer });

    const result = detector.inspect('**\x18B00000000000000');

    expect(result.passthrough).toBe('');
    expect(onTransfer).toHaveBeenCalledWith({ direction: 'download' });
  });
});
