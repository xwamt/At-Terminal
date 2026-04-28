import type { ITheme, Terminal } from '@xterm/xterm';

type CssVariableReader = (name: string) => string | undefined;

const DEFAULT_ANSI_THEME = {
  black: '#000000',
  red: '#f48771',
  green: '#b1d631',
  yellow: '#ffd866',
  blue: '#569cd6',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#dcdcaa',
  brightBlack: '#666666',
  brightRed: '#ff6b6b',
  brightGreen: '#c3e88d',
  brightYellow: '#fff569',
  brightBlue: '#82aaff',
  brightMagenta: '#ff9ccc',
  brightCyan: '#89ddff',
  brightWhite: '#ffffff'
};

const ANSI_COLOR_VARIABLES: Record<keyof typeof DEFAULT_ANSI_THEME, string> = {
  black: '--vscode-terminal-ansiBlack',
  red: '--vscode-terminal-ansiRed',
  green: '--vscode-terminal-ansiGreen',
  yellow: '--vscode-terminal-ansiYellow',
  blue: '--vscode-terminal-ansiBlue',
  magenta: '--vscode-terminal-ansiMagenta',
  cyan: '--vscode-terminal-ansiCyan',
  white: '--vscode-terminal-ansiWhite',
  brightBlack: '--vscode-terminal-ansiBrightBlack',
  brightRed: '--vscode-terminal-ansiBrightRed',
  brightGreen: '--vscode-terminal-ansiBrightGreen',
  brightYellow: '--vscode-terminal-ansiBrightYellow',
  brightBlue: '--vscode-terminal-ansiBrightBlue',
  brightMagenta: '--vscode-terminal-ansiBrightMagenta',
  brightCyan: '--vscode-terminal-ansiBrightCyan',
  brightWhite: '--vscode-terminal-ansiBrightWhite'
};

function readThemeColor(readCssVariable: CssVariableReader, name: string, fallback: string): string {
  const value = readCssVariable(name)?.trim();
  return value && value.length > 0 ? value : fallback;
}

export function createTerminalTheme(readCssVariable: CssVariableReader): ITheme {
  const background = readThemeColor(
    readCssVariable,
    '--vscode-terminal-background',
    readThemeColor(readCssVariable, '--vscode-editor-background', '#1e1e1e')
  );
  const foreground = readThemeColor(
    readCssVariable,
    '--vscode-terminal-foreground',
    readThemeColor(readCssVariable, '--vscode-foreground', '#d4d4d4')
  );

  return {
    background,
    foreground,
    cursor: readThemeColor(readCssVariable, '--vscode-terminalCursor-foreground', '#569cd6'),
    cursorAccent: readThemeColor(readCssVariable, '--vscode-terminalCursor-background', '#ffffff'),
    selectionBackground: readThemeColor(readCssVariable, '--vscode-terminal-selectionBackground', '#569cd633'),
    ...createAnsiTheme(readCssVariable)
  };
}

function createAnsiTheme(readCssVariable: CssVariableReader): typeof DEFAULT_ANSI_THEME {
  return Object.fromEntries(
    Object.entries(DEFAULT_ANSI_THEME).map(([key, fallback]) => [
      key,
      readThemeColor(readCssVariable, ANSI_COLOR_VARIABLES[key as keyof typeof DEFAULT_ANSI_THEME], fallback)
    ])
  ) as typeof DEFAULT_ANSI_THEME;
}

export function applyTerminalTheme(term: Terminal, root: HTMLElement = document.body): void {
  const styles = getComputedStyle(root);
  term.options.theme = createTerminalTheme((name) => styles.getPropertyValue(name));
}

export function watchTerminalTheme(term: Terminal): MutationObserver {
  const observer = new MutationObserver(() => applyTerminalTheme(term));
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return observer;
}
