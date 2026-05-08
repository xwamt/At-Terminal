import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTerminalTheme } from '../../webview/terminal/theme';
import { createTerminalOptions } from '../../webview/terminal/options';

describe('terminal theme integration', () => {
  it('resolves xterm colors from VS Code webview theme variables', () => {
    const values: Record<string, string> = {
      '--vscode-terminal-background': '#101820',
      '--vscode-terminal-foreground': '#f2f2f2',
      '--vscode-terminalCursor-foreground': '#ffcc00',
      '--vscode-terminal-selectionBackground': '#264f78',
      '--vscode-terminal-ansiRed': '#aa0000',
      '--vscode-terminal-ansiBrightGreen': '#00ff44'
    };

    expect(createTerminalTheme((name) => values[name])).toMatchObject({
      background: '#101820',
      foreground: '#f2f2f2',
      cursor: '#ffcc00',
      cursorAccent: '#ffffff',
      selectionBackground: '#264f78',
      black: '#000000',
      red: '#aa0000',
      green: '#b1d631',
      yellow: '#ffd866',
      blue: '#569cd6',
      magenta: '#c678dd',
      cyan: '#56b6c2',
      white: '#dcdcaa',
      brightBlack: '#666666',
      brightRed: '#ff6b6b',
      brightGreen: '#00ff44',
      brightYellow: '#fff569',
      brightBlue: '#82aaff',
      brightMagenta: '#ff9ccc',
      brightCyan: '#89ddff',
      brightWhite: '#ffffff'
    });
  });

  it('builds modern xterm options from server-provided settings', () => {
    const options = createTerminalOptions(
      {
        scrollback: 9000,
        fontSize: 16,
        fontFamily: 'JetBrains Mono'
      },
      () => undefined
    );

    expect(options).toMatchObject({
      cursorBlink: true,
      cursorStyle: 'bar',
      allowTransparency: true,
      scrollback: 9000,
      fontSize: 16,
      fontFamily: 'JetBrains Mono'
    });
    expect(options.theme).toMatchObject({
      background: '#1e1e1e',
      foreground: '#d4d4d4',
      cursor: '#569cd6',
      selectionBackground: '#569cd633'
    });
  });

  it('does not hard-code terminal surface colors in CSS', () => {
    const css = readFileSync(join(process.cwd(), 'webview/terminal/index.css'), 'utf8');

    expect(css).toContain('var(--vscode-terminal-background');
    expect(css).toContain('.xterm-viewport');
    expect(css).toContain('background: transparent');
    expect(css).toContain('border-radius: 6px');
    expect(css).toContain('padding: 8px');
    expect(css).toContain('box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2)');
    expect(css).not.toContain('#141414');
    expect(css).not.toContain('#1e1e1e');
  });

  it('reserves space below xterm so the prompt does not sit on the last visible row', () => {
    const css = readFileSync(join(process.cwd(), 'webview/terminal/index.css'), 'utf8');

    expect(css).toContain('height: calc(100% - 1.5em)');
    expect(css).toContain('margin-bottom: 1.5em');
  });
});
