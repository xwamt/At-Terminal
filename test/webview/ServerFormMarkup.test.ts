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
  });

  it('renders grouped jump host controls in the connection panel', () => {
    const html = renderServerForm(undefined, [jumpHost, appServer]);

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
  });

  it('renders editable group suggestions from existing server groups', () => {
    const html = renderServerForm(undefined, [jumpHost, appServer]);

    expect(html).toContain('name="group"');
    expect(html).toContain('list="serverGroupSuggestions"');
    expect(html).toContain('<datalist id="serverGroupSuggestions">');
    expect(html).toContain('<option value="Default"></option>');
    expect(html).toContain('<option value="prod"></option>');
  });

  it('prefills the group when adding from a selected group node', () => {
    const html = renderServerForm(undefined, [jumpHost], 'prod');

    expect(html).toContain('name="group" value="prod"');
  });

  it('displays Default for a group-scoped add from the Default group', () => {
    const html = renderServerForm(undefined, [jumpHost], 'Default');

    expect(html).toContain('name="group" value="Default"');
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
});
