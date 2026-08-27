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
  const theme = createTerminalTheme(readCssVariable);
  return {
    cursorBlink: true,
    cursorStyle: 'bar',
    // Transparency forces xterm onto slower composite paths, so only opt in when the theme
    // actually has a translucent background.
    allowTransparency: colorHasAlpha(theme.background),
    scrollback: settings.scrollback,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    theme
  };
}

/** True when a CSS color literal has an alpha channel below 1 (hex, rgba()/hsla(), transparent). */
export function colorHasAlpha(color: string | undefined): boolean {
  if (!color) {
    return false;
  }
  const value = color.trim().toLowerCase();
  if (value === 'transparent') {
    return true;
  }
  const hex = /^#(?:[0-9a-f]{4}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    const alpha = value.length === 5 ? value.slice(4) : value.slice(7);
    return parseInt(alpha.length === 1 ? alpha + alpha : alpha, 16) < 0xff;
  }
  const alphaComponent =
    /^(?:rgba|hsla)\((?:[^,]+,){3}\s*([0-9.]+%?)\s*\)$/.exec(value) ?? /\/\s*([0-9.]+%?)\s*\)$/.exec(value);
  if (alphaComponent) {
    const raw = alphaComponent[1];
    const alpha = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
    return Number.isFinite(alpha) && alpha < 1;
  }
  return false;
}
