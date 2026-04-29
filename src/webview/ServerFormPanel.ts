import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { parseServerConfig } from '../config/schema';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type SubmitPayload = Record<string, unknown>;

type ServerFormMessage =
  | { type?: 'submit'; payload?: SubmitPayload }
  | { type?: 'selectPrivateKey'; payload?: undefined }
  | { type?: string; payload?: SubmitPayload };

interface PrivateKeySelection {
  fsPath: string;
}

interface ServerFormMessageOptions {
  selectPrivateKey?: () => Thenable<PrivateKeySelection[] | undefined> | Promise<PrivateKeySelection[] | undefined>;
}

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

    panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
      await handleServerFormMessage(message, existing, configManager, onSaved, panel, {
        selectPrivateKey: () =>
          vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: 'Select SSH private key'
          })
      });
    });
  }
}

export async function handleServerFormMessage(
  message: ServerFormMessage,
  existing: ServerConfig | undefined,
  configManager: Pick<ConfigManager, 'saveServer'>,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ServerFormMessageOptions = {}
): Promise<boolean> {
  if (message.type === 'selectPrivateKey') {
    try {
      const selections = await (options.selectPrivateKey?.() ??
        vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          title: 'Select SSH private key'
        }));
      const selected = selections?.[0];
      if (selected) {
        await panel.webview.postMessage({ type: 'privateKeySelected', payload: { path: selected.fsPath } });
      } else {
        await panel.webview.postMessage({ type: 'privateKeySelectionCancelled' });
      }
    } catch (error) {
      await panel.webview.postMessage({ type: 'error', payload: formatError(error) });
    }
    return true;
  }

  if (message.type !== 'submit' || !message.payload) {
    return false;
  }

  try {
    const now = Date.now();
    const authType = String(message.payload.authType);
    const password = authType === 'password' ? optionalString(message.payload.password) : undefined;

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
    if (!existing && authType === 'password' && !password) {
      await panel.webview.postMessage({ type: 'error', payload: 'Password is required for new password-auth servers.' });
      return true;
    }

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
  const isPassword = authType === 'password';
  const isPrivateKey = authType === 'privateKey';
  const submitText = server ? 'Save Server' : 'Add Server';
  const passwordHelp = server ? 'Leave blank to keep the saved password.' : 'Stored securely in VS Code SecretStorage.';

  return `<main class="server-form-shell">
  <header class="form-header">
    <div>
      <h1>${server ? 'Edit SSH Server' : 'Add SSH Server'}</h1>
      <p>Configure a direct SSH terminal connection.</p>
    </div>
    <div id="form-status" class="form-status">Manual setup</div>
  </header>
  <form id="server-form" class="server-form">
    <div class="form-section-grid">
      <section class="form-panel form-panel-connection">
        <div class="form-panel-header">
          <h2>Connection</h2>
          <span>Target</span>
        </div>
        <div class="field-grid">
          <label class="field-stack">Label <input name="label" value="${escapeAttr(server?.label ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">Group <input name="group" value="${escapeAttr(server?.group ?? '')}" placeholder="Default" autocomplete="off"></label>
          <label class="field-stack field-wide">Host <input name="host" value="${escapeAttr(server?.host ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">Port <input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
          <label class="field-stack">Username <input name="username" value="${escapeAttr(server?.username ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">Keepalive <input name="keepAliveInterval" type="number" min="0" value="${server?.keepAliveInterval ?? 30}" required></label>
        </div>
      </section>

      <section class="form-panel form-panel-auth">
        <div class="form-panel-header">
          <h2>Authentication</h2>
          <span>Credentials</span>
        </div>
        <input id="authType" name="authType" type="hidden" value="${authType}">
        <div class="auth-card-grid" role="radiogroup" aria-label="Authentication method">
          <button class="auth-card${isPassword ? ' is-selected' : ''}" type="button" data-auth-option="password" role="radio" aria-checked="${isPassword}">
            <span class="auth-card-title">Password</span>
            <span class="auth-card-copy">Use a password saved in VS Code SecretStorage.</span>
          </button>
          <button class="auth-card${isPrivateKey ? ' is-selected' : ''}" type="button" data-auth-option="privateKey" role="radio" aria-checked="${isPrivateKey}">
            <span class="auth-card-title">Private Key</span>
            <span class="auth-card-copy">Save a local key path and read the key only when connecting.</span>
          </button>
        </div>
        <div class="auth-fields">
          <label class="field-stack auth-password-field">Password
            <input id="password" name="password" type="password" autocomplete="new-password">
            <span class="field-help">${passwordHelp}</span>
          </label>
          <label class="field-stack auth-key-field">Private key
            <div class="file-picker-row">
              <input id="privateKeyPath" name="privateKeyPath" value="${escapeAttr(server?.privateKeyPath ?? '')}" placeholder="Select a private key file">
              <button id="privateKeyBrowse" class="secondary-action" type="button">Browse...</button>
            </div>
            <span class="field-help">Only the local path is saved. Key contents are not copied into settings.</span>
          </label>
        </div>
      </section>

      <section class="form-panel form-panel-summary">
        <div class="form-panel-header">
          <h2>Summary</h2>
          <span>Review</span>
        </div>
        <div id="connectionSummary" class="connection-summary">
          <div class="summary-line" data-summary="target">Enter host and username</div>
          <div class="summary-line" data-summary="auth">Authentication: ${isPrivateKey ? 'Private Key' : 'Password'}</div>
          <div class="summary-line" data-summary="group">Group: ${escapeHtml(server?.group?.trim() || 'Default')}</div>
        </div>
      </section>
    </div>
    <footer class="form-footer">
      <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
      <div class="form-actions">
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitSpinner" class="submit-spinner" aria-hidden="true"></span>
          <span id="submitLabel">${submitText}</span>
        </button>
      </div>
    </footer>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
