import type { ITerminalOptions } from '@xterm/xterm';
import { createTerminalTheme } from './theme';

export interface TerminalUiSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
}

export function createTerminalOptions(
  settings: TerminalUiSettings,
  readCssVariable: (name: string) => string | undefined
): ITerminalOptions {
  return {
    cursorBlink: true,
    cursorStyle: 'bar',
    allowTransparency: true,
    scrollback: settings.scrollback,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme: createTerminalTheme(readCssVariable)
  };
}
