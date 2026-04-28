type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const form = document.querySelector<HTMLFormElement>('#server-form');
const authType = document.querySelector<HTMLSelectElement>('#authType');
const privateKeyPath = document.querySelector<HTMLInputElement>('#privateKeyPath');
const password = document.querySelector<HTMLInputElement>('#password');
const error = document.querySelector<HTMLElement>('#form-error');

function updateAuthFields(): void {
  const isPrivateKey = authType?.value === 'privateKey';
  privateKeyPath?.toggleAttribute('required', Boolean(isPrivateKey));
  password?.toggleAttribute('required', !isPrivateKey);
}

authType?.addEventListener('change', updateAuthFields);
updateAuthFields();

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const payload = Object.fromEntries(data.entries());
  if (!payload.label || !payload.host || !payload.username) {
    if (error) {
      error.textContent = 'Label, host, and username are required.';
    }
    return;
  }
  vscode.postMessage({ type: 'submit', payload });
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown };
  if (message.type === 'error' && typeof message.payload === 'string' && error) {
    error.textContent = message.payload;
  }
});
