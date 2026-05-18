type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const form = document.querySelector<HTMLFormElement>('#server-form');
const authType = document.querySelector<HTMLInputElement>('#authType');
const authCards = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-auth-option]'));
const privateKeyPath = document.querySelector<HTMLInputElement>('#privateKeyPath');
const privateKeyBrowse = document.querySelector<HTMLButtonElement>('#privateKeyBrowse');
const password = document.querySelector<HTMLInputElement>('#password');
const passwordToggle = document.querySelector<HTMLButtonElement>('#passwordToggle');
const error = document.querySelector<HTMLElement>('#form-error');
const testStatus = document.querySelector<HTMLElement>('#testStatus');
const testConnectionButton = document.querySelector<HTMLButtonElement>('#testConnectionButton');
const submitButton = document.querySelector<HTMLButtonElement>('#submitButton');
const submitLabel = document.querySelector<HTMLElement>('#submitLabel');
const defaultSubmitLabel = submitLabel?.textContent ?? 'Save Server';
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

function setTestStatus(message: string, state?: 'success' | 'error'): void {
  if (!testStatus) {
    return;
  }
  testStatus.textContent = message;
  testStatus.classList.toggle('is-success', state === 'success');
  testStatus.classList.toggle('is-error', state === 'error');
}

function clearTestStatus(): void {
  setTestStatus('');
}

function setSaving(isSaving: boolean): void {
  submitButton?.toggleAttribute('disabled', isSaving);
  submitButton?.classList.toggle('is-loading', isSaving);
  if (submitLabel) {
    submitLabel.textContent = isSaving ? 'Saving...' : defaultSubmitLabel;
  }
}

function setTesting(isTesting: boolean): void {
  testConnectionButton?.toggleAttribute('disabled', isTesting);
  if (testConnectionButton) {
    testConnectionButton.textContent = isTesting ? 'Testing...' : 'Test Connection';
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
  clearTestStatus();
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
  clearTestStatus();
  vscode.postMessage({ type: 'selectPrivateKey' });
});

passwordToggle?.addEventListener('click', () => {
  if (!password || !passwordToggle) {
    return;
  }
  const nextVisible = password.type === 'password';
  password.type = nextVisible ? 'text' : 'password';
  passwordToggle.textContent = nextVisible ? 'Hide' : 'Show';
  passwordToggle.setAttribute('aria-label', nextVisible ? 'Hide password' : 'Show password');
  passwordToggle.setAttribute('aria-pressed', String(nextVisible));
});

form?.addEventListener('input', () => {
  clearTestStatus();
  updateSummary();
});
updateAuthFields();
updateSummary();

function currentPayload(): Record<string, FormDataEntryValue> | undefined {
  if (!form) {
    return undefined;
  }
  const data = new FormData(form);
  return Object.fromEntries(data.entries());
}

function validatePayload(payload: Record<string, FormDataEntryValue>): boolean {
  if (!payload.label || !payload.host || !payload.username) {
    setSaving(false);
    setTesting(false);
    clearTestStatus();
    setError('Label, host, and username are required.');
    return false;
  }
  if (selectedAuth() === 'privateKey' && !String(payload.privateKeyPath ?? '').trim()) {
    setSaving(false);
    setTesting(false);
    clearTestStatus();
    setError('Select or enter a private key path.');
    return false;
  }
  return true;
}

testConnectionButton?.addEventListener('click', () => {
  clearError();
  setTestStatus('Testing connection...');
  const payload = currentPayload();
  if (!payload || !validatePayload(payload)) {
    return;
  }
  setTesting(true);
  vscode.postMessage({ type: 'testConnection', payload });
});

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  clearError();
  clearTestStatus();
  const payload = currentPayload();
  if (!payload || !validatePayload(payload)) {
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
    clearTestStatus();
    updateSummary();
  }
  if (message.type === 'error' && typeof message.payload === 'string') {
    setSaving(false);
    setError(message.payload);
  }
  if (message.type === 'connectionTestResult' && isConnectionTestPayload(message.payload)) {
    setTesting(false);
    setTestStatus(message.payload.message, message.payload.ok ? 'success' : 'error');
  }
});

function isPrivateKeyPayload(value: unknown): value is { path: string } {
  return Boolean(value && typeof value === 'object' && typeof (value as { path?: unknown }).path === 'string');
}

function isConnectionTestPayload(value: unknown): value is { ok: boolean; message: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { ok?: unknown }).ok === 'boolean' &&
      typeof (value as { message?: unknown }).message === 'string'
  );
}
