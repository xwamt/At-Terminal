import { describe, expect, it } from 'vitest';
import { renderServerForm } from '../../src/webview/ServerFormPanel';

describe('ServerFormPanel markup', () => {
  it('renders a structured VS Code styled form instead of a plain vertical list', () => {
    const html = renderServerForm();

    expect(html).toContain('class="server-form-shell"');
    expect(html).toContain('class="form-section"');
    expect(html).toContain('class="field-grid"');
    expect(html).toContain('class="form-actions"');
    expect(html).toContain('id="form-status"');
  });
});
