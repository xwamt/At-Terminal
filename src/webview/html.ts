import * as vscode from 'vscode';
import { createNonce } from '../utils/nonce';

export interface WebviewAsset {
  script: vscode.Uri;
  style?: vscode.Uri;
}

export function renderJsonScript(id: string, value: unknown): string {
  const serialized = JSON.stringify(value ?? null).replace(/</g, '\\u003c');
  return `<script id="${id}" type="application/json">${serialized}</script>`;
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  asset: WebviewAsset,
  body: string,
  data?: Readonly<Record<string, unknown>>
): string {
  const nonce = createNonce();
  const styleTag = asset.style ? `<link rel="stylesheet" href="${webview.asWebviewUri(asset.style)}">` : '';
  const dataScripts = data
    ? Object.entries(data)
        .map(([id, payload]) => renderJsonScript(id, payload))
        .join('\n  ')
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}
  ${dataScripts ? `${dataScripts}\n  ` : ''}<script nonce="${nonce}" src="${webview.asWebviewUri(asset.script)}"></script>
</body>
</html>`;
}

