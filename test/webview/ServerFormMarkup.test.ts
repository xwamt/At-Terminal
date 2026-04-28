import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderServerForm } from '../../src/webview/ServerFormPanel';

describe('ServerFormPanel markup', () => {
  it('renders a polished management panel instead of a plain vertical list', () => {
    const html = renderServerForm();

    expect(html).toContain('class="server-form-shell"');
    expect(html).toContain('class="form-panel-grid"');
    expect(html).toContain('class="form-panel"');
    expect(html).toContain('class="form-panel-header"');
    expect(html).toContain('class="field-stack"');
    expect(html).toContain('class="field-grid"');
    expect(html).toContain('class="form-footer"');
    expect(html).toContain('class="primary-action"');
    expect(html).toContain('id="form-status"');
  });

  it('defines dense VS Code styled controls for the management panel', () => {
    const css = readFileSync(join(process.cwd(), 'webview/server-form/index.css'), 'utf8');

    expect(css).toContain('.form-panel-grid');
    expect(css).toContain('.form-panel-header');
    expect(css).toContain('.field-stack');
    expect(css).toContain('.form-footer');
    expect(css).toContain('.primary-action');
    expect(css).toContain('border-radius: 6px');
  });
});
