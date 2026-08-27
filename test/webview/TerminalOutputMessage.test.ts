import { describe, expect, it, vi } from 'vitest';
import { semanticHighlightText } from '../../webview/terminal/semanticHighlight';
import {
  createTerminalByteDecoder,
  normalizeTerminalEncoding,
  writeTerminalOutputMessage
} from '../../webview/terminal/output';

describe('terminal output messages', () => {
  it('writes binary byte payloads straight to xterm so ANSI control bytes stay raw', () => {
    const terminal = { write: vi.fn() };
    const bytes = Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x52, 0x45, 0x44, 0x1b, 0x5b, 0x30, 0x6d]);

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, terminal)).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith(bytes);
  });

  it('accepts the full byte range including bytes that are not valid UTF-8', () => {
    const terminal = { write: vi.fn() };
    const bytes = Uint8Array.from([0x00, 0x7f, 0x80, 0xc3, 0xff]);

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, terminal)).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith(bytes);
  });

  it('rejects byte payloads that are not Uint8Array (base64 strings are no longer supported)', () => {
    const terminal = { write: vi.fn() };

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: 'aGVsbG8=' }, terminal)).toBe(false);
    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: [65, 66] }, terminal)).toBe(false);

    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('keeps string output support for host-generated notices', () => {
    const terminal = { write: vi.fn() };

    expect(writeTerminalOutputMessage({ type: 'output', payload: '\x1b[32mGREEN\x1b[0m' }, terminal)).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith('\x1b[32mGREEN\x1b[0m');
  });

  it('acknowledges consumed bytes through the xterm write callback for flow control', () => {
    const acknowledged: number[] = [];
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: vi.fn((_data: string | Uint8Array, callback?: () => void) => {
        if (callback) {
          callbacks.push(callback);
        }
      })
    };
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);

    writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, terminal, {
      acknowledge: (count) => acknowledged.push(count)
    });

    expect(acknowledged).toEqual([]);
    callbacks[0]();
    expect(acknowledged).toEqual([5]);
  });

  it('acknowledges the original byte count even when the chunk is decoded to text', () => {
    const acknowledged: number[] = [];
    const terminal = {
      write: vi.fn((_data: string | Uint8Array, callback?: () => void) => callback?.())
    };
    const gbkBytes = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK

    writeTerminalOutputMessage({ type: 'outputBytes', payload: gbkBytes }, terminal, {
      decodeBytes: createTerminalByteDecoder('gbk'),
      acknowledge: (count) => acknowledged.push(count)
    });

    expect(terminal.write).toHaveBeenCalledWith('你好', expect.any(Function));
    expect(acknowledged).toEqual([4]);
  });

  it('adds semantic ANSI colors to plain terminal output when the enhancement is enabled', () => {
    const output = semanticHighlightText('ERROR failed at /var/log/app.log from 10.0.0.1 status 500 OK');

    expect(output).toContain('\x1b[31mERROR\x1b[0m');
    expect(output).toContain('\x1b[31mfailed\x1b[0m');
    expect(output).toContain('\x1b[34m/var/log/app.log\x1b[0m');
    expect(output).toContain('\x1b[36m10.0.0.1\x1b[0m');
    expect(output).toContain('\x1b[32m500\x1b[0m');
    expect(output).toContain('\x1b[32mOK\x1b[0m');
  });

  it('leaves native ANSI colored output untouched so xterm keeps the real terminal colors', () => {
    const nativeAnsi = '\x1b[31mRED\x1b[0m error /var/log/app.log 500';

    expect(semanticHighlightText(nativeAnsi)).toBe(nativeAnsi);
  });

  it('writes highlighted byte output as text only when semantic highlighting changes plain output', () => {
    const terminal = { write: vi.fn() };
    const payload = Uint8Array.from(Buffer.from('ERROR /var/log/app.log 500', 'utf8'));

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload }, terminal, { semanticHighlight: true })).toBe(
      true
    );

    expect(terminal.write).toHaveBeenCalledWith(
      '\x1b[31mERROR\x1b[0m \x1b[34m/var/log/app.log\x1b[0m \x1b[32m500\x1b[0m'
    );
  });
});

describe('terminal output encoding', () => {
  it('normalizes unknown encodings to utf-8', () => {
    expect(normalizeTerminalEncoding(undefined)).toBe('utf-8');
    expect(normalizeTerminalEncoding('latin1')).toBe('utf-8');
    expect(normalizeTerminalEncoding('gbk')).toBe('gbk');
    expect(normalizeTerminalEncoding('big5')).toBe('big5');
  });

  it('returns no decoder for utf-8 so raw bytes flow to xterm untouched', () => {
    expect(createTerminalByteDecoder('utf-8')).toBeUndefined();
    expect(createTerminalByteDecoder(undefined)).toBeUndefined();
  });

  it('streams GBK sequences split across chunk boundaries without corruption', () => {
    const decode = createTerminalByteDecoder('gbk')!;
    const hello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 你好 in GBK

    const first = decode(Uint8Array.from(hello.subarray(0, 3)));
    const second = decode(Uint8Array.from(hello.subarray(3)));

    expect(first + second).toBe('你好');
  });

  it('decodes Big5 output to the expected text', () => {
    const decode = createTerminalByteDecoder('big5')!;

    expect(decode(Uint8Array.from([0xa4, 0xa4, 0xa4, 0xe5]))).toBe('中文');
  });
});
