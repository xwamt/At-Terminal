import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderServerForm } from '../../src/webview/ServerFormPanel';

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
    expect(css).toContain('.file-picker-row');
    expect(css).toContain('.connection-summary');
    expect(css).toContain('.primary-action.is-loading');
  });
});
