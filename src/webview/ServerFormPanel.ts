import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { parseServerConfig } from '../config/schema';
import { testSshConnection } from '../ssh/SshConnectionTester';
import { requireHostKeyVerifier, type HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';
import { buildWebviewStrings, t } from '../i18n/t';

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
    existing: ServerConfig | undefined,
    hostKeyVerifier: HostKeyVerifier,
    initialGroup?: string
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'sshServerForm',
      existing
        ? t('Edit SSH Server: {label}', { label: existing.label })
        : t('Add SSH Server'),
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
      renderServerForm(existing, servers, initialGroup),
      {
        serverFormStrings: buildWebviewStrings({
          saving: 'Saving...',
          testing: 'Testing...',
          testConnection: 'Test Connection',
          errorRequired: 'Label, host, and username are required.',
          errorPrivateKey: 'Select or enter a private key path.',
          errorJumpHost: 'Select a jump host server or choose Direct connection.',
          testingVia: 'Testing connection via {name}...',
          testingDirect: 'Testing connection...',
          summaryEnterHostUser: 'Enter host and username',
          summaryAuthPrefix: 'Authentication: {auth}',
          summaryGroupPrefix: 'Group: {group}',
          summaryRouteVia: 'Route: via {host}',
          summaryRouteDirect: 'Route: Direct connection',
          summaryAgentReadOnly: 'Agent commands: read-only commands trusted',
          summaryAgentManual: 'Agent commands: manual approval',
          hide: 'Hide',
          show: 'Show',
          hidePassword: 'Hide password',
          showPassword: 'Show password',
          privateKey: 'Private Key',
          password: 'Password',
          default: 'Default',
          directConnection: 'Direct connection'
        })
      }
    );

    panel.webview.onDidReceiveMessage(async (message: ServerFormMessage) => {
      await handleServerFormMessage(message, existing, configManager, onSaved, panel, {
        hostKeyVerifier,
        selectPrivateKey: () =>
          vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            title: t('Select SSH private key')
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
      await panel.webview.postMessage({
        type: 'error',
        payload: t('Password is required for new password-auth servers.')
      });
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
          requireHostKeyVerifier(options.hostKeyVerifier)
        ));

    await runTest(server, password);
    await panel.webview.postMessage({
      type: 'connectionTestResult',
      payload: { ok: true, message: t('Connection test succeeded.') }
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
  throw new Error(t('Password is required for new password-auth servers.'));
}

function serverFromPayload(payload: SubmitPayload, existing: ServerConfig | undefined): ServerConfig {
  const now = Date.now();
  const agentCommandAutoApprove =
    payload.agentCommandAutoApprove === 'on' || payload.agentCommandAutoApprove === true;
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
    agentCommandAutoApprove,
    backgroundConnectionAllowed:
      agentCommandAutoApprove &&
      (payload.backgroundConnectionAllowed === 'on' || payload.backgroundConnectionAllowed === true),
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
  return group === 'Default' || group === t('Default') ? undefined : group;
}

export function renderServerForm(server?: ServerConfig, servers: ServerConfig[] = [], initialGroup?: string): string {
  const authType = server?.authType ?? 'password';
  const isPassword = authType === 'password';
  const isPrivateKey = authType === 'privateKey';
  const submitText = server ? t('Save Server') : t('Add Server');
  const passwordHelp = server
    ? t('Leave blank to keep the saved password.')
    : t('Stored securely in VS Code SecretStorage.');
  const jumpHostOptions = servers.filter((candidate) => candidate.id !== server?.id);
  const selectedJumpHost = jumpHostOptions.find((candidate) => candidate.id === server?.jumpHostId);
  const selectedJumpHostGroup = selectedJumpHost ? displayGroupName(selectedJumpHost.group) : '';
  const jumpHostGroups = groupNames(jumpHostOptions);
  const agentCommandTrusted = server?.agentCommandAutoApprove === true;
  const backgroundConnectionAllowed = agentCommandTrusted && server?.backgroundConnectionAllowed === true;
  const agentCommandTrustSummary = agentCommandTrusted
    ? t('Agent commands: state-changing commands still ask')
    : t('Agent commands: manual approval');
  const groupSuggestions = groupNames(servers);
  const groupValue = server ? server.group ?? '' : initialGroup ?? '';

  return `<main class="server-form-shell">
  <header class="form-header">
    <div>
      <h1>${escapeHtml(server ? t('Edit SSH Server') : t('Add SSH Server'))}</h1>
      <p>${escapeHtml(t('Configure a direct SSH terminal connection.'))}</p>
    </div>
    <div id="form-status" class="form-status">${escapeHtml(t('Manual setup'))}</div>
  </header>
  <form id="server-form" class="server-form">
    <div class="form-section-grid">
      <section class="form-panel form-panel-connection">
        <div class="form-panel-header">
          <h2>${escapeHtml(t('Connection'))}</h2>
          <span>${escapeHtml(t('Target'))}</span>
        </div>
        <div class="field-grid">
          <label class="field-stack">${escapeHtml(t('Label'))} <input name="label" value="${escapeAttr(server?.label ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">${escapeHtml(t('Group'))}
            <div class="group-combobox">
              <input name="group" value="${escapeAttr(displayGroupName(groupValue))}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="serverGroupSuggestions">
              <button class="group-combobox-toggle" type="button" aria-label="${escapeAttr(t('Show all groups'))}" aria-controls="serverGroupSuggestions">v</button>
              <div id="serverGroupSuggestions" class="group-combobox-menu" role="listbox" hidden>
                ${groupSuggestionOptions(groupSuggestions, groupValue)}
              </div>
            </div>
          </label>
          <label class="field-stack field-wide">${escapeHtml(t('Host'))} <input name="host" value="${escapeAttr(server?.host ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">${escapeHtml(t('Port'))} <input name="port" type="number" min="1" max="65535" value="${server?.port ?? 22}" required></label>
          <label class="field-stack">${escapeHtml(t('Username'))} <input name="username" value="${escapeAttr(server?.username ?? '')}" required autocomplete="off"></label>
          <label class="field-stack">${escapeHtml(t('Keepalive'))} <input name="keepAliveInterval" type="number" min="0" value="${server?.keepAliveInterval ?? 30}" required></label>
          <div class="trust-block field-wide">
            <label class="trust-toggle-row" for="agentCommandAutoApprove">
              <span class="trust-toggle-copy">
                <span class="trust-toggle-title">${escapeHtml(t('Trust agent remote commands'))}</span>
                <span class="field-help">${escapeHtml(t('Skip confirmation unless the command changes state (rm, chmod, systemctl restart, apt, docker, or an interpreter such as sh, python, awk, sed), or hides what it runs behind quotes, escapes, redirects or command substitution. Every stage of a pipeline or chain is checked. Commands the blocklist does not name run without asking.'))}</span>
              </span>
              <input id="agentCommandAutoApprove" name="agentCommandAutoApprove" type="checkbox"${agentCommandTrusted ? ' checked' : ''}>
            </label>
            <div id="backgroundConnectionSub" class="trust-sub${agentCommandTrusted ? ' is-open' : ''}"${agentCommandTrusted ? '' : ' hidden'}>
              <div class="trust-sub-inner">
                <label class="trust-toggle-row" for="backgroundConnectionAllowed">
                  <span class="trust-toggle-copy">
                    <span class="trust-toggle-title">${escapeHtml(t('Allow background connections'))}</span>
                    <span class="field-help">${escapeHtml(t('Allow MCP to connect to this server in the background. Only applies to the MCP build.'))}</span>
                  </span>
                  <input id="backgroundConnectionAllowed" name="backgroundConnectionAllowed" type="checkbox"${backgroundConnectionAllowed ? ' checked' : ''}${agentCommandTrusted ? '' : ' disabled'}>
                </label>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="form-right-col">
        <section class="form-panel form-panel-auth">
          <div class="form-panel-header">
            <h2>${escapeHtml(t('Authentication'))}</h2>
            <span>${escapeHtml(t('Credentials'))}</span>
          </div>
          <input id="authType" name="authType" type="hidden" value="${authType}">
          <div class="auth-card-grid" role="radiogroup" aria-label="${escapeAttr(t('Authentication method'))}">
            <button class="auth-card${isPassword ? ' is-selected' : ''}" type="button" data-auth-option="password" role="radio" aria-checked="${isPassword}">
              <span class="auth-card-title">${escapeHtml(t('Password'))}</span>
              <span class="auth-card-copy">${escapeHtml(t('Use a password saved in VS Code SecretStorage.'))}</span>
            </button>
            <button class="auth-card${isPrivateKey ? ' is-selected' : ''}" type="button" data-auth-option="privateKey" role="radio" aria-checked="${isPrivateKey}">
              <span class="auth-card-title">${escapeHtml(t('Private Key'))}</span>
              <span class="auth-card-copy">${escapeHtml(t('Save a local key path and read the key only when connecting.'))}</span>
            </button>
          </div>
          <div class="auth-fields">
            <label class="field-stack auth-password-field">${escapeHtml(t('Password'))}
              <div class="password-input-row">
                <input id="password" name="password" type="password" autocomplete="new-password">
                <button id="passwordToggle" class="secondary-action password-toggle" type="button" aria-label="${escapeAttr(t('Show password'))}" aria-pressed="false">${escapeHtml(t('Show'))}</button>
              </div>
              <span class="field-help">${escapeHtml(passwordHelp)}</span>
            </label>
            <label class="field-stack auth-key-field">${escapeHtml(t('Private key'))}
              <div class="file-picker-row">
                <input id="privateKeyPath" name="privateKeyPath" value="${escapeAttr(server?.privateKeyPath ?? '')}" placeholder="${escapeAttr(t('Select a private key file'))}">
                <button id="privateKeyBrowse" class="secondary-action" type="button">${escapeHtml(t('Browse...'))}</button>
              </div>
              <span class="field-help">${escapeHtml(t('Only the local path is saved. Key contents are not copied into settings.'))}</span>
            </label>
          </div>
        </section>

        <section class="form-panel form-panel-jump">
          <div class="form-panel-header">
            <h2>${escapeHtml(t('Jump Host'))}</h2>
            <span>${escapeHtml(t('Bastion route'))}</span>
          </div>
          <div class="field-grid">
            <label class="field-stack">${escapeHtml(t('Jump Host Group'))}
              <select name="jumpHostGroup">
                <option value="">${escapeHtml(t('Direct connection'))}</option>
                ${jumpHostGroups
                  .map((group) => {
                    const selected = group === selectedJumpHostGroup ? ' selected' : '';
                    return `<option value="${escapeAttr(group)}"${selected}>${escapeHtml(group)}</option>`;
                  })
                  .join('')}
              </select>
            </label>
            <label class="field-stack jump-host-server-field">${escapeHtml(t('Jump Host Server'))}
              <select name="jumpHostId"${selectedJumpHost ? '' : ' disabled'}>
                <option value="">${escapeHtml(t('Select a server'))}</option>
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
          </div>
        </section>
      </div>

      <section class="form-panel form-panel-summary">
        <div class="form-panel-header">
          <h2>${escapeHtml(t('Summary'))}</h2>
          <span>${escapeHtml(t('Review'))}</span>
        </div>
        <div id="connectionSummary" class="connection-summary">
          <div class="summary-line" data-summary="target">${escapeHtml(t('Enter host and username'))}</div>
          <div class="summary-line" data-summary="auth">${escapeHtml(t('Authentication: {auth}', { auth: isPrivateKey ? t('Private Key') : t('Password') }))}</div>
          <div class="summary-line" data-summary="group">${escapeHtml(t('Group: {group}', { group: server?.group?.trim() || t('Default') }))}</div>
          <div class="summary-line" data-summary="route">${escapeHtml(
            selectedJumpHost
              ? t('Route: via {host}', { host: selectedJumpHost.label })
              : t('Route: Direct connection')
          )}</div>
          <div class="summary-line" data-summary="agentCommands">${escapeHtml(agentCommandTrustSummary)}</div>
        </div>
      </section>
    </div>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">${escapeHtml(t('Test Connection'))}</button>
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitSpinner" class="submit-spinner" aria-hidden="true"></span>
          <span id="submitLabel">${escapeHtml(submitText)}</span>
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
  return Array.from(new Set([t('Default'), ...servers.map((server) => displayGroupName(server.group))])).sort((a, b) =>
    a.localeCompare(b)
  );
}

function groupSuggestionOptions(groups: string[], selectedGroup: string): string {
  const selected = displayGroupName(selectedGroup);
  const options = Array.from(new Set([...groups, selected])).sort((a, b) => a.localeCompare(b));
  return options
    .map((group) => {
      return `<button class="group-combobox-option" type="button" role="option" data-group-option="${escapeAttr(group)}">${escapeHtml(
        group
      )}</button>`;
    })
    .join('');
}

function displayGroupName(group: string | undefined): string {
  const trimmed = group?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : t('Default');
}

