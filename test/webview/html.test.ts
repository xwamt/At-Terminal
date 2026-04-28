import { describe, expect, it } from 'vitest';
import { renderWebviewHtml } from '../../src/webview/html';

describe('renderWebviewHtml', () => {
  it('allows xterm runtime styles while keeping scripts nonce-protected', () => {
    const html = renderWebviewHtml(
      {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: { fsPath: string }) => `webview-uri:${uri.fsPath}`
      } as never,
      {
        script: { fsPath: 'dist/webview/terminal.js' } as never,
        style: { fsPath: 'dist/webview/terminal.css' } as never
      },
      '<main></main>'
    );

    expect(html).toContain("style-src vscode-resource: 'unsafe-inline';");
    expect(html).toContain("script-src vscode-resource: 'nonce-");
  });
});
