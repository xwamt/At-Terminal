import { describe, expect, it, vi } from 'vitest';
import { semanticHighlightText } from '../../webview/terminal/semanticHighlight';
import { writeTerminalOutputMessage } from '../../webview/terminal/output';

describe('terminal output messages', () => {
  it('writes byte output to xterm as Uint8Array so ANSI control bytes stay raw', () => {
    const terminal = { write: vi.fn() };
    const bytes = [0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x52, 0x45, 0x44, 0x1b, 0x5b, 0x30, 0x6d];

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, terminal)).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith(Uint8Array.from(bytes));
  });

  it('keeps string output support for older webview messages', () => {
    const terminal = { write: vi.fn() };

    expect(writeTerminalOutputMessage({ type: 'output', payload: '\x1b[32mGREEN\x1b[0m' }, terminal)).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith('\x1b[32mGREEN\x1b[0m');
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
    const bytes = [...Buffer.from('ERROR /var/log/app.log 500', 'utf8')];

    expect(writeTerminalOutputMessage({ type: 'outputBytes', payload: bytes }, terminal, { semanticHighlight: true })).toBe(true);

    expect(terminal.write).toHaveBeenCalledWith('\x1b[31mERROR\x1b[0m \x1b[34m/var/log/app.log\x1b[0m \x1b[32m500\x1b[0m');
  });
});
