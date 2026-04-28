import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './index.css';

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>('#terminal');
const status = document.querySelector<HTMLElement>('#status');

if (!container) {
  throw new Error('Missing terminal container');
}

const term = new Terminal({
  cursorBlink: true,
  scrollback: Number(container.dataset.scrollback ?? '5000'),
  fontSize: Number(container.dataset.fontSize ?? '14'),
  fontFamily: container.dataset.fontFamily || 'Cascadia Code, Menlo, monospace',
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4'
  }
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(container);
fitAddon.fit();

term.onData((data) => {
  vscode.postMessage({ type: 'input', payload: data });
});

const resizeObserver = new ResizeObserver(() => {
  fitAddon.fit();
  vscode.postMessage({ type: 'resize', rows: term.rows, cols: term.cols });
});
resizeObserver.observe(container);

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown };
  if (message.type === 'output' && typeof message.payload === 'string') {
    term.write(message.payload);
  }
  if (message.type === 'status' && typeof message.payload === 'string' && status) {
    status.textContent = message.payload;
  }
});

vscode.postMessage({ type: 'ready', rows: term.rows, cols: term.cols });
