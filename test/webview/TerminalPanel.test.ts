import { describe, expect, it } from 'vitest';
import { createTerminalAssets, renderTerminalBody, resolveTerminalSettings } from '../../src/webview/TerminalPanel';

describe('TerminalPanel rendering helpers', () => {
  it('links the bundled xterm stylesheet emitted by esbuild', () => {
    const assets = createTerminalAssets({ fsPath: 'extension-root' } as never);

    expect(assets.style).toBeDefined();
    expect(assets.style!.fsPath).toBe('extension-root/dist/webview/terminal.css');
  });

  it('renders terminal settings into the webview data attributes', () => {
    const body = renderTerminalBody({
      scrollback: 1234,
      fontSize: 16,
      fontFamily: 'JetBrains Mono'
    });

    expect(body).toContain('data-scrollback="1234"');
    expect(body).toContain('data-font-size="16"');
    expect(body).toContain('data-font-family="JetBrains Mono"');
  });

  it('reads contributed terminal settings from VS Code configuration', () => {
    const settings = resolveTerminalSettings({
      get: <T>(key: string, defaultValue: T): T => {
        const values: Record<string, unknown> = {
          scrollback: 9000,
          terminalFontSize: 18,
          terminalFontFamily: 'Fira Code'
        };
        return (values[key] ?? defaultValue) as T;
      }
    });

    expect(settings).toEqual({
      scrollback: 9000,
      fontSize: 18,
      fontFamily: 'Fira Code'
    });
  });
});
