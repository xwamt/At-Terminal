import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import { createTerminalOptions } from './options';
import { writeTerminalOutputMessage } from './output';
import { watchTerminalTheme } from './theme';
import { watchTerminalZebraStripes } from './zebra';

type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

const vscode = acquireVsCodeApi();
const container = document.querySelector<HTMLElement>('#terminal');
const status = document.querySelector<HTMLElement>('#status');

if (!container) {
  throw new Error('Missing terminal container');
}

const term = new Terminal(
  createTerminalOptions(
    {
      scrollback: Number(container.dataset.scrollback ?? '5000'),
      fontSize: Number(container.dataset.fontSize ?? '14'),
      fontFamily: container.dataset.fontFamily || 'Cascadia Code, Menlo, monospace'
    },
    (name) => getComputedStyle(document.body).getPropertyValue(name)
  )
);

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
term.open(container);
watchTerminalTheme(term);
watchTerminalZebraStripes(term);
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
  writeTerminalOutputMessage(message, term, { semanticHighlight: container.dataset.semanticHighlight === 'true' });
  if (message.type === 'status' && typeof message.payload === 'string' && status) {
    const text = status.querySelector<HTMLElement>('.terminal-status-text');
    if (text) {
      text.textContent = message.payload;
    } else {
      status.textContent = message.payload;
    }
    status.classList.toggle('terminal-status--connected', message.payload === 'Connected');
    status.classList.toggle('terminal-status--disconnected', message.payload === 'Disconnected');
    status.classList.toggle('terminal-status--connecting', message.payload !== 'Connected' && message.payload !== 'Disconnected');
  }
});

vscode.postMessage({ type: 'ready', rows: term.rows, cols: term.cols });
