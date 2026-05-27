import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { parseServerConfig } from '../config/schema';
import { testSshConnection } from '../ssh/SshConnectionTester';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type SubmitPayload = Record<string, unknown>;

type ServerFormMessage =
  | { type?: 'submit'; payload?: SubmitPayload }
  | { type?: 'testConnection'; payload?: SubmitPayload }
  | { type?: 'selectPrivateKey'; payload?: undefined }
  | { type?: string; payload?: SubmitPayload };

interface PrivateKeySelection {
  fsPath: string;
}

interface ServerFormMessageOptions {
  selectPrivateKey?: () => Thenable<PrivateKeySelection[] | undefined> | Promise<PrivateKeySelection[] | undefined>;
  testConnection?: (server: ServerConfig, password?: string) => Promise<void>;
  hostKeyVerifier?: HostKeyVerifier;
}

export class ServerFormPanel {
  static async open(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    onSaved: () => void,
    existing?: ServerConfig,
    hostKeyVerifier?: HostKeyVerifier,
    initialGroup?: string
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'sshServerForm',
      existing ? `Edit SSH Server: ${existing.label}` : 'Add SSH Server',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    const servers = await configManager.listServers();

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'server-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'server-form', 'index.css')
      },
      renderServerForm(existing, servers, initialGroup)
    );

    panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
      await handleServerFormMessage(message, existing, configManager, onSaved, panel, {
        hostKeyVerifier,
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
  configManager: Pick<ConfigManager, 'saveServer' | 'getPassword' | 'getServer'>,
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
    if (message.type === 'testConnection' && message.payload) {
      await handleConnectionTest(message.payload, existing, configManager, panel, options);
      return true;
    }
    return false;
  }

  try {
    const authType = String(message.payload.authType);
    const password = authType === 'password' ? optionalString(message.payload.password) : undefined;
    const server = serverFromPayload(message.payload, existing);
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

async function handleConnectionTest(
  payload: SubmitPayload,
  existing: ServerConfig | undefined,
  configManager: Pick<ConfigManager, 'getPassword' | 'getServer'>,
  panel: Pick<vscode.WebviewPanel, 'webview'>,
  options: ServerFormMessageOptions
): Promise<void> {
  try {
    const server = serverFromPayload(payload, existing);
    const password = await passwordForConnectionTest(payload, server, existing, configManager);
    const runTest =
      options.testConnection ??
      ((candidate: ServerConfig, candidatePassword?: string) =>
        testSshConnection(
          candidate,
          {
            getPassword: async () => candidatePassword,
            getServer: (id) => configManager.getServer(id)
          },
          options.hostKeyVerifier
        ));

    await runTest(server, password);
    await panel.webview.postMessage({
      type: 'connectionTestResult',
      payload: { ok: true, message: 'Connection test succeeded.' }
    });
  } catch (error) {
    await panel.webview.postMessage({
      type: 'connectionTestResult',
      payload: { ok: false, message: formatError(error) }
    });
  }
}

async function passwordForConnectionTest(
  payload: SubmitPayload,
  server: ServerConfig,
  existing: ServerConfig | undefined,
  configManager: Pick<ConfigManager, 'getPassword'>
): Promise<string | undefined> {
  if (server.authType !== 'password') {
    return undefined;
  }

  const password = optionalString(payload.password);
  if (password) {
    return password;
  }
  if (existing) {
    return configManager.getPassword(existing.id);
  }
  throw new Error('Password is required for new password-auth servers.');
}

function serverFromPayload(payload: SubmitPayload, existing: ServerConfig | undefined): ServerConfig {
  const now = Date.now();
  return parseServerConfig({
    id: existing?.id ?? randomUUID(),
    label: String(payload.label ?? '').trim(),
    group: optionalGroup(payload.group),
    host: String(payload.host ?? '').trim(),
    port: Number(payload.port ?? 22),
    username: String(payload.username ?? '').trim(),
    authType: String(payload.authType),
    privateKeyPath: optionalString(payload.privateKeyPath),
    jumpHostId: optionalString(payload.jumpHostId),
    agentCommandAutoApprove: payload.agentCommandAutoApprove === 'on' || payload.agentCommandAutoApprove === true,
    keepAliveInterval: Number(payload.keepAliveInterval ?? 30),
    encoding: 'utf-8',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

function optionalGroup(value: unknown): string | undefined {
  const group = optionalString(value);
  return group === 'Default' ? undefined : group;
}

export function renderServerForm(server?: ServerConfig, servers: ServerConfig[] = [], initialGroup?: string): string {
  const authType = server?.authType ?? 'password';
  const isPassword = authType === 'password';
  const isPrivateKey = authType === 'privateKey';
  const submitText = server ? 'Save Server' : 'Add Server';
  const passwordHelp = server ? 'Leave blank to keep the saved password.' : 'Stored securely in VS Code SecretStorage.';
  const jumpHostOptions = servers.filter((candidate) => candidate.id !== server?.id);
  const selectedJumpHost = jumpHostOptions.find((candidate) => candidate.id === server?.jumpHostId);
  const selectedJumpHostGroup = selectedJumpHost ? displayGroupName(selectedJumpHost.group) : '';
  const jumpHostGroups = groupNames(jumpHostOptions);
  const agentCommandTrustSummary = server?.agentCommandAutoApprove
    ? 'Agent commands: trusted for non-destructive commands'
    : 'Agent commands: manual approval';
  const groupSuggestions = groupNames(servers);
  const groupValue = server ? server.group ?? '' : initialGroup ?? '';

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
          <label class="field-stack">Group
            <select name="group">
              ${selectGroupOptions(groupSuggestions, groupValue)}
            </select>
          </label>
          <label class="field-stack field-wide">Host <input name="host" value="${escapeAttr(server?.host ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">Port <input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
          <label class="field-stack">Username <input name="username" value="${escapeAttr(server?.username ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">Keepalive <input name="keepAliveInterval" type="number" min="0" value="${server?.keepAliveInterval ?? 30}" required></label>
          <label class="field-stack">Jump Host Group
            <select name="jumpHostGroup">
              <option value="">Direct connection</option>
              ${jumpHostGroups
                .map((group) => {
                  const selected = group === selectedJumpHostGroup ? ' selected' : '';
                  return `<option value="${escapeAttr(group)}"${selected}>${escapeHtml(group)}</option>`;
                })
                .join('')}
            </select>
          </label>
          <label class="field-stack jump-host-server-field">Jump Host Server
            <select name="jumpHostId"${selectedJumpHost ? '' : ' disabled'}>
              <option value="">Select a server</option>
              ${jumpHostOptions
                .map((candidate) => {
                  const group = displayGroupName(candidate.group);
                  const selected = candidate.id === server?.jumpHostId ? ' selected' : '';
                  return `<option value="${escapeAttr(candidate.id)}" data-group="${escapeAttr(group)}"${selected}>${escapeHtml(
                    formatJumpHostOption(candidate)
                  )}</option>`;
                })
                .join('')}
            </select>
          </label>
          <label class="field-stack field-wide trust-toggle-row">
            <span class="trust-toggle-copy">
              <span class="trust-toggle-title">Trust agent remote commands</span>
              <span class="field-help">Run non-destructive MCP remote commands without asking each time.</span>
            </span>
            <input name="agentCommandAutoApprove" type="checkbox"${server?.agentCommandAutoApprove ? ' checked' : ''}>
          </label>
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
            <div class="password-input-row">
              <input id="password" name="password" type="password" autocomplete="new-password">
              <button id="passwordToggle" class="secondary-action password-toggle" type="button" aria-label="Show password" aria-pressed="false">Show</button>
            </div>
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
          <div class="summary-line" data-summary="route">Route: ${
            selectedJumpHost ? `via ${escapeHtml(selectedJumpHost.label)}` : 'Direct connection'
          }</div>
          <div class="summary-line" data-summary="agentCommands">${agentCommandTrustSummary}</div>
        </div>
      </section>
    </div>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">Test Connection</button>
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

function formatJumpHostOption(server: ServerConfig): string {
  return `${server.label} - ${server.username}@${server.host}:${server.port}`;
}

function groupNames(servers: ServerConfig[]): string[] {
  return Array.from(new Set(['Default', ...servers.map((server) => displayGroupName(server.group))])).sort((a, b) =>
    a.localeCompare(b)
  );
}

function selectGroupOptions(groups: string[], selectedGroup: string): string {
  const selected = displayGroupName(selectedGroup);
  const options = Array.from(new Set([...groups, selected])).sort((a, b) => a.localeCompare(b));
  return options
    .map((group) => {
      const selectedAttr = group === selected ? ' selected' : '';
      return `<option value="${escapeAttr(group)}"${selectedAttr}>${escapeHtml(group)}</option>`;
    })
    .join('');
}

function displayGroupName(group: string | undefined): string {
  const trimmed = group?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'Default';
}
