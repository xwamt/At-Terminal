import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
import { renderServerForm } from '../../src/webview/ServerFormPanel';

const jumpHost: ServerConfig = {
  id: 'jump-1',
  label: 'Bastion CN',
  host: 'bastion.example.com',
  port: 22,
  username: 'ops',
  authType: 'password',
  keepAliveInterval: 30,
  encoding: 'utf-8',
  createdAt: 1,
  updatedAt: 1
};

const appServer: ServerConfig = {
  id: 'app-1',
  label: 'App CN',
  group: 'prod',
  host: 'app.example.com',
  port: 22,
  username: 'deploy',
  authType: 'password',
  keepAliveInterval: 30,
  encoding: 'utf-8',
  createdAt: 1,
  updatedAt: 1
};

describe('ServerFormPanel markup', () => {
  it('renders the refreshed server form structure', () => {
    const html = renderServerForm();

    expect(html).toContain('class="server-form-shell"');
    expect(html).toContain('class="form-section-grid"');
    expect(html).toContain('data-auth-option="password"');
    expect(html).toContain('data-auth-option="privateKey"');
    expect(html).toContain('id="authType"');
    expect(html).toContain('id="privateKeyBrowse"');
    expect(html).toContain('id="connectionSummary"');
    expect(html).toContain('id="passwordToggle"');
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('id="testConnectionButton"');
    expect(html).toContain('id="submitButton"');
    expect(html).toContain('id="submitLabel"');
    expect(html).toContain('id="submitSpinner"');
  });

  it('explains that a blank edit password keeps the saved password', () => {
    const html = renderServerForm({
      id: 'server-1',
      label: 'Production',
      group: 'prod',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(html).toContain('Leave blank to keep the saved password.');
  });

  it('defines VS Code styled controls for auth cards and summary state', () => {
    const css = readFileSync(join(process.cwd(), 'webview/server-form/index.css'), 'utf8');

    expect(css).toContain('.form-section-grid');
    expect(css).toContain('.auth-card-grid');
    expect(css).toContain('.auth-card');
    expect(css).toContain('.auth-card.is-selected');
    expect(css).toContain('.password-input-row');
    expect(css).toContain('.test-status');
    expect(css).toContain('.file-picker-row');
    expect(css).toContain('.connection-summary');
    expect(css).toContain('.primary-action.is-loading');
    expect(css).toContain('.jump-host-server-field');
    expect(css).toContain('.form-right-col');
    expect(css).toContain('.trust-block');
    expect(css).toContain('.trust-sub');
    expect(css).toContain('.group-combobox');
    expect(css).toContain('.group-combobox-menu');
    expect(css).toContain('.group-combobox-option');
  });

  it('renders grouped jump host controls in a panel under authentication', () => {
    const html = renderServerForm(undefined, [jumpHost, appServer]);

    expect(html).toContain('class="form-right-col"');
    expect(html).toContain('class="form-panel form-panel-jump"');
    expect(html).toContain('<h2>Jump Host</h2>');
    expect(html).toContain('name="jumpHostGroup"');
    expect(html).toContain('name="jumpHostId"');
    expect(html).toContain('Direct connection');
    expect(html).toContain('<option value="Default">Default</option>');
    expect(html).toContain('<option value="prod">prod</option>');
    expect(html).toContain('data-group="Default"');
    expect(html).toContain('Bastion CN - ops@bastion.example.com:22');
    expect(html).toContain('data-group="prod"');
    expect(html).toContain('App CN - deploy@app.example.com:22');
    expect(html).toContain('data-summary="route"');
    expect(html.indexOf('form-panel-auth')).toBeLessThan(html.indexOf('form-panel-jump'));
  });

  it('renders server group choices as editable suggestions', () => {
    const html = renderServerForm(undefined, [jumpHost, appServer]);

    expect(html).toContain('name="group"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-controls="serverGroupSuggestions"');
    expect(html).toContain('class="group-combobox-toggle"');
    expect(html).toContain('<div id="serverGroupSuggestions" class="group-combobox-menu" role="listbox" hidden>');
    expect(html).toContain('data-group-option="Default"');
    expect(html).toContain('data-group-option="prod"');
    expect(html).not.toContain('<select name="group">');
    expect(html).not.toContain('<datalist id="serverGroupSuggestions">');
  });

  it('keeps the live group summary wired to editable group input', () => {
    const script = readFileSync(join(process.cwd(), 'webview/server-form/index.ts'), 'utf8');

    expect(script).toContain('function field(name: string): HTMLInputElement | HTMLSelectElement | null');
    expect(script).toContain('element instanceof HTMLInputElement');
  });

  it('keeps typed group filtering separate from manual dropdown expansion', () => {
    const script = readFileSync(join(process.cwd(), 'webview/server-form/index.ts'), 'utf8');

    expect(script).toContain('function openGroupMenu(showAll = false): void');
    expect(script).toContain('function isGroupMenuOpen(): boolean');
    expect(script).toContain("groupInput?.addEventListener('input', () =>");
    expect(script).toContain('openGroupMenu(false)');
    expect(script).toContain("groupCombobox?.addEventListener('focusout', (event) =>");
    expect(script).toContain("groupToggle?.addEventListener('click', () =>");
    expect(script).toContain('if (isGroupMenuOpen())');
    expect(script).toContain('closeGroupMenu()');
    expect(script).toContain('openGroupMenu(true)');
    expect(script).toContain('suppressNextGroupFocus = true');
  });

  it('keeps background connection nested under trust in the form script', () => {
    const script = readFileSync(join(process.cwd(), 'webview/server-form/index.ts'), 'utf8');

    expect(script).toContain('function updateTrustFields(): void');
    expect(script).toContain("document.querySelector<HTMLInputElement>('input[name=\"backgroundConnectionAllowed\"]')");
    expect(script).toContain('background.disabled = !trusted');
    expect(script).toContain('background.checked = false');
    expect(script).toContain('updateTrustFields()');
  });

  it('keeps the group suggestions hidden until script opens them', () => {
    const css = readFileSync(join(process.cwd(), 'webview/server-form/index.css'), 'utf8');

    expect(css).toContain('.group-combobox-menu[hidden]');
    expect(css).toContain('display: none;');
  });

  it('prefills the group when adding from a selected group node', () => {
    const html = renderServerForm(undefined, [jumpHost], 'prod');

    expect(html).toContain('name="group" value="prod"');
    expect(html).toContain('data-group-option="prod"');
  });

  it('displays Default for a group-scoped add from the Default group', () => {
    const html = renderServerForm(undefined, [jumpHost], 'Default');

    expect(html).toContain('name="group" value="Default"');
    expect(html).toContain('data-group-option="Default"');
  });

  it('excludes the edited server from jump host options', () => {
    const html = renderServerForm(jumpHost, [jumpHost]);

    expect(html).toContain('Direct connection');
    expect(html).not.toContain('Bastion CN - ops@bastion.example.com:22');
  });

  it('marks the saved jump host as selected when editing', () => {
    const html = renderServerForm(
      {
        ...jumpHost,
        id: 'app-1',
        label: 'App',
        host: '10.0.0.20',
        jumpHostId: 'jump-1'
      },
      [jumpHost]
    );

    expect(html).toContain('<option value="Default" selected>Default</option>');
    expect(html).toContain('<option value="jump-1" data-group="Default" selected>');
    expect(html).toContain('Route: via Bastion CN');
  });

  it('renders the agent command trust switch off by default', () => {
    const html = renderServerForm();

    expect(html).toContain('name="agentCommandAutoApprove"');
    expect(html).toContain('Trust agent remote commands');
    expect(html).toContain('Run non-destructive MCP remote commands without asking each time.');
    expect(html).toContain('Agent commands: manual approval');
    expect(html).not.toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
  });

  it('renders the agent command trust switch checked for trusted servers', () => {
    const html = renderServerForm({
      id: 'server-1',
      label: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(html).toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
    expect(html).toContain('Agent commands: trusted for non-destructive commands');
  });

  it('nests the background connection switch under trust and hides it by default', () => {
    const html = renderServerForm();

    expect(html).toContain('class="trust-block field-wide"');
    expect(html).toContain('id="backgroundConnectionSub"');
    expect(html).toContain('name="backgroundConnectionAllowed"');
    expect(html).toContain('Allow background connections');
    expect(html).toContain('Allow MCP to connect to this server in the background. Only applies to the MCP build.');
    expect(html).toMatch(/id="backgroundConnectionSub"[^>]*hidden/);
    expect(html).toMatch(/name="backgroundConnectionAllowed"[^>]*disabled/);
    expect(html).not.toMatch(/name="backgroundConnectionAllowed"[^>]*checked/);
  });

  it('shows the background connection switch only when trust is enabled', () => {
    const html = renderServerForm({
      id: 'server-1',
      label: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      agentCommandAutoApprove: true,
      backgroundConnectionAllowed: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(html).toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
    expect(html).toContain('class="trust-sub is-open"');
    expect(html).not.toMatch(/id="backgroundConnectionSub"[^>]*hidden/);
    expect(html).toMatch(/name="backgroundConnectionAllowed"[^>]*checked/);
    expect(html).not.toMatch(/name="backgroundConnectionAllowed"[^>]*disabled/);
  });

  it('does not check background connections when trust is off even if previously authorized', () => {
    const html = renderServerForm({
      id: 'server-1',
      label: 'Production',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      authType: 'password',
      backgroundConnectionAllowed: true,
      keepAliveInterval: 30,
      encoding: 'utf-8',
      createdAt: 1,
      updatedAt: 2
    });

    expect(html).not.toMatch(/name="agentCommandAutoApprove"[^>]*checked/);
    expect(html).toMatch(/id="backgroundConnectionSub"[^>]*hidden/);
    expect(html).not.toMatch(/name="backgroundConnectionAllowed"[^>]*checked/);
    expect(html).toMatch(/name="backgroundConnectionAllowed"[^>]*disabled/);
  });
});
