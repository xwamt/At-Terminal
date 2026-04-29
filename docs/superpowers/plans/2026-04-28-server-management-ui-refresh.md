# Server Management UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the SSH server add/edit UI with clearer authentication cards, native private key file selection, safer password edit semantics, better save feedback, and richer server tree metadata.

**Architecture:** Keep the existing VS Code extension architecture: `ServerFormPanel` renders the webview and handles extension-host messages, `webview/server-form/index.ts` owns browser-side form state, and `TreeItems.ts` owns server tree presentation. Add one webview message for private key selection while preserving the existing `submit` save flow and `ServerConfig` schema.

**Tech Stack:** TypeScript, VS Code extension API, Webview postMessage, Vitest, existing esbuild pipeline, VS Code theme CSS variables.

---

## File Structure

- Modify `src/webview/ServerFormPanel.ts`
  - Render refreshed form sections, authentication card markup, summary markup, private-key browse controls, and edit-mode password guidance.
  - Handle `selectPrivateKey` messages through `vscode.window.showOpenDialog`.
  - Keep `submit` save behavior, but require a password only for new password-auth servers.
  - Preserve an existing password when editing and the password field is blank.

- Modify `webview/server-form/index.ts`
  - Manage auth-card selection and hidden `authType` value.
  - Toggle password/private key controls.
  - Post `selectPrivateKey` messages and apply `privateKeySelected` responses.
  - Update live connection summary as inputs change.
  - Disable submit controls during save and restore on errors.

- Modify `webview/server-form/index.css`
  - Style the sectioned form, auth cards, file picker row, helper text, summary area, errors, and disabled/loading state.
  - Preserve narrow-width responsive behavior.

- Modify `src/tree/TreeItems.ts`
  - Add a server icon.
  - Expand tooltip text with non-sensitive connection metadata.

- Modify `test/webview/ServerFormMarkup.test.ts`
  - Assert refreshed markup hooks and CSS classes exist.

- Modify `test/webview/ServerFormPanel.test.ts`
  - Cover private key picker messages and password-preserving edit semantics.

- Modify `test/tree/ServerTreeProvider.test.ts`
  - Cover server tree tooltip and icon metadata.

---

### Task 1: Lock Down Refreshed Form Markup Expectations

**Files:**
- Modify: `test/webview/ServerFormMarkup.test.ts`
- Modify later: `src/webview/ServerFormPanel.ts`
- Modify later: `webview/server-form/index.css`

- [ ] **Step 1: Replace the first markup test with refreshed structure assertions**

In `test/webview/ServerFormMarkup.test.ts`, replace the test named `renders a polished management panel instead of a plain vertical list` with:

```ts
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
```

- [ ] **Step 2: Add an edit-mode password guidance test**

Append this test in the same `describe('ServerFormPanel markup', ...)` block:

```ts
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
```

- [ ] **Step 3: Replace the CSS expectations test**

Replace the test named `defines dense VS Code styled controls for the management panel` with:

```ts
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
```

- [ ] **Step 4: Run the markup test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: FAIL because the current form does not yet contain `form-section-grid`, auth cards, Browse button, summary, or loading hooks.

- [ ] **Step 5: Commit the failing test**

```bash
git add test/webview/ServerFormMarkup.test.ts
git commit -m "test: specify refreshed server form markup"
```

---

### Task 2: Add Extension-Host Message Tests for Private Key Selection and Password Preservation

**Files:**
- Modify: `test/webview/ServerFormPanel.test.ts`
- Modify later: `src/webview/ServerFormPanel.ts`

- [ ] **Step 1: Extend imports**

Change the import from:

```ts
import { describe, expect, it, vi } from 'vitest';
```

to:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../src/config/schema';
```

- [ ] **Step 2: Add a reusable server fixture**

Below the imports, add:

```ts
function server(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
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
    updatedAt: 1,
    ...overrides
  };
}
```

- [ ] **Step 3: Add a test for selected private key paths**

Append this test:

```ts
it('posts a selected private key path back to the form webview', async () => {
  const postMessage = vi.fn();
  const selectPrivateKey = vi.fn(async () => [{ fsPath: 'C:\\Users\\alan\\.ssh\\id_ed25519' }]);

  const handled = await handleServerFormMessage(
    { type: 'selectPrivateKey' },
    undefined,
    { saveServer: vi.fn() } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage } } as never,
    { selectPrivateKey }
  );

  expect(handled).toBe(true);
  expect(selectPrivateKey).toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({
    type: 'privateKeySelected',
    payload: { path: 'C:\\Users\\alan\\.ssh\\id_ed25519' }
  });
});
```

- [ ] **Step 4: Add a test for cancelled private key selection**

Append this test:

```ts
it('posts a cancellation message when private key selection is cancelled', async () => {
  const postMessage = vi.fn();
  const selectPrivateKey = vi.fn(async () => undefined);

  const handled = await handleServerFormMessage(
    { type: 'selectPrivateKey' },
    undefined,
    { saveServer: vi.fn() } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage } } as never,
    { selectPrivateKey }
  );

  expect(handled).toBe(true);
  expect(postMessage).toHaveBeenCalledWith({ type: 'privateKeySelectionCancelled' });
});
```

- [ ] **Step 5: Add a test for password required on add**

Append this test:

```ts
it('requires a password when adding a password-auth server', async () => {
  const postMessage = vi.fn();
  const saveServer = vi.fn();

  const handled = await handleServerFormMessage(
    {
      type: 'submit',
      payload: {
        label: 'Production',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        password: '',
        keepAliveInterval: 30
      }
    },
    undefined,
    { saveServer } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage } } as never
  );

  expect(handled).toBe(true);
  expect(saveServer).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({
    type: 'error',
    payload: 'Password is required for new password-auth servers.'
  });
});
```

- [ ] **Step 6: Add a test for blank edit password preservation**

Append this test:

```ts
it('does not overwrite an existing password when editing with a blank password', async () => {
  const saveServer = vi.fn();

  const handled = await handleServerFormMessage(
    {
      type: 'submit',
      payload: {
        label: 'Production',
        group: 'prod',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        password: '',
        keepAliveInterval: 30
      }
    },
    server(),
    { saveServer } as never,
    vi.fn(),
    { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
  );

  expect(handled).toBe(true);
  expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), undefined);
});
```

- [ ] **Step 7: Run the panel tests and verify they fail**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormPanel.test.ts
```

Expected: FAIL because `handleServerFormMessage` does not accept the injected `selectPrivateKey` option and does not handle `selectPrivateKey`.

- [ ] **Step 8: Commit the failing tests**

```bash
git add test/webview/ServerFormPanel.test.ts
git commit -m "test: specify server form private key picker"
```

---

### Task 3: Implement ServerFormPanel Message Handling and Markup

**Files:**
- Modify: `src/webview/ServerFormPanel.ts`
- Test: `test/webview/ServerFormPanel.test.ts`
- Test: `test/webview/ServerFormMarkup.test.ts`

- [ ] **Step 1: Add message and picker option types**

Near the current `type SubmitPayload = Record<string, unknown>;`, replace it with:

```ts
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
```

- [ ] **Step 2: Pass the default VS Code file picker from `ServerFormPanel.open`**

Replace the `onDidReceiveMessage` callback in `ServerFormPanel.open` with:

```ts
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
```

- [ ] **Step 3: Extend the `handleServerFormMessage` signature**

Change the function signature to:

```ts
export async function handleServerFormMessage(
  message: ServerFormMessage,
  existing: ServerConfig | undefined,
  configManager: Pick<ConfigManager, 'saveServer'>,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: ServerFormMessageOptions = {}
): Promise<boolean> {
```

- [ ] **Step 4: Handle `selectPrivateKey` before submit handling**

Insert this block at the top of `handleServerFormMessage`, before the current `if (message.type !== 'submit' || !message.payload)` guard:

```ts
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
```

- [ ] **Step 5: Require passwords only when adding password-auth servers**

After `const authType = String(message.payload.authType);`, add:

```ts
const password = authType === 'password' ? optionalString(message.payload.password) : undefined;
if (!existing && authType === 'password' && !password) {
  await panel.webview.postMessage({ type: 'error', payload: 'Password is required for new password-auth servers.' });
  return true;
}
```

Then remove the later duplicate line:

```ts
const password = authType === 'password' ? optionalString(message.payload.password) : undefined;
```

Keep the existing save call as:

```ts
await configManager.saveServer(server, password);
```

- [ ] **Step 6: Replace `renderServerForm` markup**

Replace the body of `renderServerForm` with this implementation:

```ts
export function renderServerForm(server?: ServerConfig): string {
  const authType = server?.authType ?? 'password';
  const isPassword = authType === 'password';
  const isPrivateKey = authType === 'privateKey';
  const submitText = server ? 'Save Server' : 'Add Server';
  const passwordHelp = server
    ? 'Leave blank to keep the saved password.'
    : 'Stored securely in VS Code SecretStorage.';

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
```

- [ ] **Step 7: Add `escapeHtml`**

Below `escapeAttr`, add:

```ts
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
```

- [ ] **Step 8: Run focused tests**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
```

Expected: the `ServerFormPanel` tests pass; markup tests may still fail on CSS expectations until Task 5.

- [ ] **Step 9: Commit implementation**

```bash
git add src/webview/ServerFormPanel.ts test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts
git commit -m "feat: refresh server form host messaging"
```

---

### Task 4: Implement Webview-Side Form State

**Files:**
- Modify: `webview/server-form/index.ts`
- Test manually through build and webview behavior after Task 5

- [ ] **Step 1: Replace `webview/server-form/index.ts` with the refreshed client controller**

Use this complete file content:

```ts
type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const form = document.querySelector<HTMLFormElement>('#server-form');
const authType = document.querySelector<HTMLInputElement>('#authType');
const authCards = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-auth-option]'));
const privateKeyPath = document.querySelector<HTMLInputElement>('#privateKeyPath');
const privateKeyBrowse = document.querySelector<HTMLButtonElement>('#privateKeyBrowse');
const password = document.querySelector<HTMLInputElement>('#password');
const error = document.querySelector<HTMLElement>('#form-error');
const submitButton = document.querySelector<HTMLButtonElement>('#submitButton');
const submitLabel = document.querySelector<HTMLElement>('#submitLabel');
const summaryTarget = document.querySelector<HTMLElement>('[data-summary="target"]');
const summaryAuth = document.querySelector<HTMLElement>('[data-summary="auth"]');
const summaryGroup = document.querySelector<HTMLElement>('[data-summary="group"]');

function field(name: string): HTMLInputElement | null {
  return form?.elements.namedItem(name) instanceof HTMLInputElement
    ? (form.elements.namedItem(name) as HTMLInputElement)
    : null;
}

function setError(message: string): void {
  if (error) {
    error.textContent = message;
  }
}

function clearError(): void {
  setError('');
}

function setSaving(isSaving: boolean): void {
  submitButton?.toggleAttribute('disabled', isSaving);
  submitButton?.classList.toggle('is-loading', isSaving);
  if (submitLabel) {
    submitLabel.textContent = isSaving ? 'Saving...' : submitButton?.textContent?.includes('Add') ? 'Add Server' : 'Save Server';
  }
}

function selectedAuth(): string {
  return authType?.value === 'privateKey' ? 'privateKey' : 'password';
}

function selectAuth(value: string): void {
  const next = value === 'privateKey' ? 'privateKey' : 'password';
  if (authType) {
    authType.value = next;
  }
  updateAuthFields();
  updateSummary();
}

function updateAuthFields(): void {
  const isPrivateKey = selectedAuth() === 'privateKey';
  privateKeyPath?.toggleAttribute('required', isPrivateKey);
  password?.toggleAttribute('required', !isPrivateKey && !password?.closest('.auth-password-field')?.textContent?.includes('Leave blank'));

  for (const card of authCards) {
    const selected = card.dataset.authOption === selectedAuth();
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-checked', String(selected));
  }

  document.body.classList.toggle('auth-private-key', isPrivateKey);
  document.body.classList.toggle('auth-password', !isPrivateKey);
}

function updateSummary(): void {
  const username = field('username')?.value.trim() ?? '';
  const host = field('host')?.value.trim() ?? '';
  const port = field('port')?.value.trim() || '22';
  const group = field('group')?.value.trim() || 'Default';

  if (summaryTarget) {
    summaryTarget.textContent = username && host ? `${username}@${host}:${port}` : 'Enter host and username';
  }
  if (summaryAuth) {
    summaryAuth.textContent = `Authentication: ${selectedAuth() === 'privateKey' ? 'Private Key' : 'Password'}`;
  }
  if (summaryGroup) {
    summaryGroup.textContent = `Group: ${group}`;
  }
}

authCards.forEach((card) => {
  card.addEventListener('click', () => {
    selectAuth(card.dataset.authOption ?? 'password');
  });
});

privateKeyBrowse?.addEventListener('click', () => {
  clearError();
  vscode.postMessage({ type: 'selectPrivateKey' });
});

form?.addEventListener('input', updateSummary);
updateAuthFields();
updateSummary();

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  clearError();
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  if (!payload.label || !payload.host || !payload.username) {
    setSaving(false);
    setError('Label, host, and username are required.');
    return;
  }
  if (selectedAuth() === 'privateKey' && !String(payload.privateKeyPath ?? '').trim()) {
    setSaving(false);
    setError('Select or enter a private key path.');
    return;
  }
  setSaving(true);
  vscode.postMessage({ type: 'submit', payload });
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown };
  if (message.type === 'privateKeySelected' && isPrivateKeyPayload(message.payload)) {
    if (privateKeyPath) {
      privateKeyPath.value = message.payload.path;
    }
    clearError();
    updateSummary();
  }
  if (message.type === 'error' && typeof message.payload === 'string') {
    setSaving(false);
    setError(message.payload);
  }
});

function isPrivateKeyPayload(value: unknown): value is { path: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string');
}
```

- [ ] **Step 2: Fix the submit label state so it does not depend on current button text**

If TypeScript or manual review shows the `setSaving` label restoration is brittle, add this constant near `submitLabel`:

```ts
const defaultSubmitLabel = submitLabel?.textContent ?? 'Save Server';
```

Then replace the label assignment inside `setSaving` with:

```ts
submitLabel.textContent = isSaving ? 'Saving...' : defaultSubmitLabel;
```

- [ ] **Step 3: Run typecheck and resolve any DOM typing errors**

Run:

```powershell
npm run typecheck
```

Expected: PASS. If it fails on DOM type narrowing in `field`, replace `field` with:

```ts
function field(name: string): HTMLInputElement | null {
  const element = form?.querySelector<HTMLInputElement>(`[name="${name}"]`);
  return element ?? null;
}
```

- [ ] **Step 4: Commit the client controller**

```bash
git add webview/server-form/index.ts
git commit -m "feat: manage refreshed server form state"
```

---

### Task 5: Implement Refreshed CSS

**Files:**
- Modify: `webview/server-form/index.css`
- Test: `test/webview/ServerFormMarkup.test.ts`

- [ ] **Step 1: Replace the legacy grid names and add refreshed styles**

In `webview/server-form/index.css`, rename `.form-panel-grid` to `.form-section-grid` everywhere. Then add these blocks after the existing `.field-wide` block:

```css
.form-section-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(280px, 0.9fr);
  gap: 14px;
  align-items: start;
}

.form-panel-summary {
  grid-column: 1 / -1;
}

.auth-card-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 14px 14px 0;
}

.auth-card {
  display: grid;
  gap: 5px;
  min-width: 0;
  text-align: left;
  color: var(--vscode-foreground);
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 6px;
  padding: 10px;
}

.auth-card:hover {
  border-color: var(--vscode-focusBorder);
}

.auth-card.is-selected {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}

.auth-card-title {
  font-size: 13px;
  font-weight: 650;
}

.auth-card-copy,
.field-help {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.4;
}

.auth-card.is-selected .auth-card-copy {
  color: inherit;
}

.auth-fields {
  padding: 14px;
}

.auth-private-key .auth-password-field,
.auth-password .auth-key-field {
  display: none;
}

.file-picker-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.secondary-action {
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  border: 0;
  border-radius: 4px;
  padding: 7px 10px;
  line-height: 1.35;
}

.secondary-action:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.connection-summary {
  display: grid;
  gap: 6px;
  padding: 14px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.4;
}

.summary-line:first-child {
  color: var(--vscode-foreground);
  font-size: 13px;
  font-weight: 650;
}

.primary-action[disabled] {
  cursor: not-allowed;
  opacity: 0.72;
}

.primary-action.is-loading {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.submit-spinner {
  display: none;
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
}

.primary-action.is-loading .submit-spinner {
  display: inline-block;
  animation: submit-spin 800ms linear infinite;
}

@keyframes submit-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 2: Update the media query**

In the existing `@media (max-width: 760px)` block, replace `.form-panel-grid` with `.form-section-grid` and add `.auth-card-grid` to the single-column rule:

```css
.form-section-grid,
.field-grid,
.auth-card-grid {
  grid-template-columns: 1fr;
}
```

- [ ] **Step 3: Run markup/CSS test**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormMarkup.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```powershell
npm run build
```

Expected: PASS and rebuilt `dist/webview/server-form.js`.

- [ ] **Step 5: Commit CSS**

```bash
git add webview/server-form/index.css dist/webview/server-form.js dist/webview/server-form.js.map
git commit -m "style: refresh server form layout"
```

---

### Task 6: Add Server Tree Icon and Tooltip Tests

**Files:**
- Modify: `test/tree/ServerTreeProvider.test.ts`
- Modify later: `src/tree/TreeItems.ts`

- [ ] **Step 1: Add direct `ServerTreeItem` assertions**

Append this test to `test/tree/ServerTreeProvider.test.ts`:

```ts
it('shows non-sensitive server metadata in server tree items', () => {
  const item = new ServerTreeItem({
    id: 'server-1',
    label: 'Production',
    group: 'prod',
    host: 'example.com',
    port: 2222,
    username: 'deploy',
    authType: 'privateKey',
    privateKeyPath: 'C:\\Users\\alan\\.ssh\\id_ed25519',
    keepAliveInterval: 45,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 2
  });

  expect(item.description).toBe('deploy@example.com:2222');
  expect(item.iconPath).toEqual(expect.objectContaining({ id: 'server' }));
  expect(String(item.tooltip)).toContain('Production');
  expect(String(item.tooltip)).toContain('Group: prod');
  expect(String(item.tooltip)).toContain('Host: example.com');
  expect(String(item.tooltip)).toContain('Port: 2222');
  expect(String(item.tooltip)).toContain('Username: deploy');
  expect(String(item.tooltip)).toContain('Authentication: Private Key');
  expect(String(item.tooltip)).toContain('Keepalive: 45s');
  expect(String(item.tooltip)).not.toContain('id_ed25519');
});
```

- [ ] **Step 2: Run tree test and verify it fails**

Run:

```powershell
cmd /c npm run test -- test/tree/ServerTreeProvider.test.ts
```

Expected: FAIL because `ServerTreeItem` does not yet set `iconPath` or expanded tooltip text.

- [ ] **Step 3: Commit failing test**

```bash
git add test/tree/ServerTreeProvider.test.ts
git commit -m "test: specify server tree metadata"
```

---

### Task 7: Implement Server Tree Polish

**Files:**
- Modify: `src/tree/TreeItems.ts`
- Test: `test/tree/ServerTreeProvider.test.ts`

- [ ] **Step 1: Update `ServerTreeItem`**

Replace the `ServerTreeItem` constructor body with:

```ts
constructor(public readonly server: ServerConfig) {
  super(server.label, vscode.TreeItemCollapsibleState.None);
  this.contextValue = 'server';
  this.iconPath = new vscode.ThemeIcon('server');
  this.description = `${server.username}@${server.host}:${server.port}`;
  this.tooltip = [
    server.label,
    `Group: ${server.group?.trim() || 'Default'}`,
    `Host: ${server.host}`,
    `Port: ${server.port}`,
    `Username: ${server.username}`,
    `Authentication: ${server.authType === 'privateKey' ? 'Private Key' : 'Password'}`,
    `Keepalive: ${server.keepAliveInterval}s`
  ].join('\n');
  this.command = {
    command: 'sshManager.connect',
    title: 'Connect',
    arguments: [this]
  };
}
```

- [ ] **Step 2: Run tree test**

Run:

```powershell
cmd /c npm run test -- test/tree/ServerTreeProvider.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit tree polish**

```bash
git add src/tree/TreeItems.ts test/tree/ServerTreeProvider.test.ts
git commit -m "feat: enrich server tree metadata"
```

---

### Task 8: Final Verification and Integration

**Files:**
- Review: `src/webview/ServerFormPanel.ts`
- Review: `webview/server-form/index.ts`
- Review: `webview/server-form/index.css`
- Review: `src/tree/TreeItems.ts`
- Review: tests changed in earlier tasks

- [ ] **Step 1: Run focused webview and tree tests**

Run:

```powershell
cmd /c npm run test -- test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts test/tree/ServerTreeProvider.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full typecheck**

Run:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full build**

Run:

```powershell
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 5: Manual VS Code extension smoke test**

Run the extension development host from VS Code after building. Verify:

```text
1. SSH activity bar opens.
2. Add Server opens refreshed form.
3. Password card is selected by default.
4. Switching to Private Key shows the private key row.
5. Browse opens a native VS Code file picker.
6. Cancelling Browse keeps the form unchanged.
7. Selecting a key fills the path field.
8. Summary updates when username, host, port, group, or auth mode changes.
9. Submit button shows Saving... and disables during save.
10. Editing a password-auth server with blank password keeps the old password.
11. Server tree item shows server icon and expanded tooltip metadata.
```

- [ ] **Step 6: Final commit if any integration fixes were needed**

If Step 1-5 required follow-up fixes, commit only those changed files:

```bash
git add src/webview/ServerFormPanel.ts webview/server-form/index.ts webview/server-form/index.css src/tree/TreeItems.ts test/webview/ServerFormPanel.test.ts test/webview/ServerFormMarkup.test.ts test/tree/ServerTreeProvider.test.ts dist/webview/server-form.js dist/webview/server-form.js.map
git commit -m "fix: complete server management ui refresh"
```

If no fixes were needed after prior commits, do not create an empty commit.

---

## Self-Review

- Spec coverage: private key file picker is covered by Tasks 2-4; auth cards and form polish by Tasks 1, 3, and 5; loading/disabled state by Tasks 1, 4, and 5; password preservation by Tasks 2 and 3; tree icon and tooltip by Tasks 6 and 7; verification by Task 8.
- Scope check: this plan stays inside one UI refresh surface and does not implement the deferred console, wizard, SSH config import, SSH agent support, passphrase flow, connection test, or bulk management features.
- Type consistency: message names are consistently `selectPrivateKey`, `privateKeySelected`, and `privateKeySelectionCancelled`; the selected path payload is consistently `{ path: string }`; saved server data still uses existing `privateKeyPath`.
