import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { parseServerConfig } from '../config/schema';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type SubmitPayload = Record<string, unknown>;

export class ServerFormPanel {
  static open(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    onSaved: () => void,
    existing?: ServerConfig
  ): void {
    const panel = vscode.window.createWebviewPanel(
      'sshServerForm',
      existing ? `Edit SSH Server: ${existing.label}` : 'Add SSH Server',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'server-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'server-form', 'index.css')
      },
      renderServerForm(existing)
    );

    panel.webview.onDidReceiveMessage(async (message: { type?: string; payload?: SubmitPayload }) => {
      await handleServerFormMessage(message, existing, configManager, onSaved, panel);
    });
  }
}

export async function handleServerFormMessage(
  message: { type?: string; payload?: SubmitPayload },
  existing: ServerConfig | undefined,
  configManager: Pick<ConfigManager, 'saveServer'>,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>
): Promise<boolean> {
  if (message.type !== 'submit' || !message.payload) {
    return false;
  }

  try {
    const now = Date.now();
    const authType = String(message.payload.authType);
    const server = parseServerConfig({
      id: existing?.id ?? randomUUID(),
      label: String(message.payload.label ?? '').trim(),
      group: optionalString(message.payload.group),
      host: String(message.payload.host ?? '').trim(),
      port: Number(message.payload.port ?? 22),
      username: String(message.payload.username ?? '').trim(),
      authType,
      privateKeyPath: optionalString(message.payload.privateKeyPath),
      keepAliveInterval: Number(message.payload.keepAliveInterval ?? 30),
      encoding: 'utf-8',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
    const password = authType === 'password' ? optionalString(message.payload.password) : undefined;
    await configManager.saveServer(server, password);
    onSaved();
    panel.dispose();
  } catch (error) {
    await panel.webview.postMessage({ type: 'error', payload: formatError(error) });
  }

  return true;
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

export function renderServerForm(server?: ServerConfig): string {
  const authType = server?.authType ?? 'password';
  return `<main class="server-form-shell">
  <header class="form-header">
    <div>
      <h1>${server ? 'Edit SSH Server' : 'Add SSH Server'}</h1>
      <p>Configure a direct SSH terminal connection.</p>
    </div>
    <div id="form-status" class="form-status">Manual setup</div>
  </header>
  <form id="server-form" class="server-form">
    <div class="form-panel-grid">
      <section class="form-panel">
        <div class="form-panel-header">
          <h2>Connection</h2>
          <span>Target</span>
        </div>
        <div class="field-grid">
          <label class="field-stack">Label <input name="label" value="${escapeAttr(server?.label ?? '')}" required></label>
          <label class="field-stack">Group <input name="group" value="${escapeAttr(server?.group ?? '')}" placeholder="Default"></label>
          <label class="field-stack field-wide">Host <input name="host" value="${escapeAttr(server?.host ?? '')}" required></label>
          <label class="field-stack">Port <input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
          <label class="field-stack">Username <input name="username" value="${escapeAttr(server?.username ?? '')}" required></label>
          <label class="field-stack">Keepalive <input name="keepAliveInterval" type="number" min="0" value="${server?.keepAliveInterval ?? 30}" required></label>
        </div>
      </section>
      <section class="form-panel">
        <div class="form-panel-header">
          <h2>Authentication</h2>
          <span>Credentials</span>
        </div>
        <div class="field-grid">
          <label class="field-stack">Method
            <select id="authType" name="authType">
              <option value="password"${authType === 'password' ? ' selected' : ''}>Password</option>
              <option value="privateKey"${authType === 'privateKey' ? ' selected' : ''}>Private Key</option>
            </select>
          </label>
          <label class="field-stack">Password <input id="password" name="password" type="password"></label>
          <label class="field-stack field-wide">Private Key Path <input id="privateKeyPath" name="privateKeyPath" value="${escapeAttr(server?.privateKeyPath ?? '')}"></label>
        </div>
      </section>
    </div>
    <footer class="form-footer">
      <div id="form-error" class="form-error"></div>
      <div class="form-actions">
        <button class="primary-action" type="submit">${server ? 'Save Server' : 'Add Server'}</button>
      </div>
    </footer>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
