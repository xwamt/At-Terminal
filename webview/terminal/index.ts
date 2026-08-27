import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import {
  createTerminalKeyboardHandler,
  installTerminalClipboardPasteHandler,
  installTerminalFocusRecovery,
  resolveTerminalStatusClass,
  type TerminalClipboard
} from './clipboard';
import { createTerminalOptions } from './options';
import { createTerminalByteDecoder, writeTerminalOutputMessage, type TerminalOutputOptions } from './output';
import { setupTerminalRenderer } from './renderer';
import { createTerminalSearchController, isTerminalSearchShortcut } from './search';
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
      scrollback: Number(container.dataset.scrollback ?? '10000'),
      fontSize: Number(container.dataset.fontSize ?? '14'),
      fontFamily: container.dataset.fontFamily || 'Cascadia Code, Menlo, monospace'
    },
    (name) => getComputedStyle(document.body).getPropertyValue(name)
  )
);

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon());
const searchAddon = new SearchAddon();
term.loadAddon(searchAddon);
term.open(container);
watchTerminalTheme(term);

// Zebra striping restyles DOM rows, so it forces the DOM renderer; otherwise WebGL is
// attached and any load failure or GPU context loss falls back to the DOM renderer.
const zebraStripes = container.dataset.zebraStripes === 'true';
setupTerminalRenderer(term, {
  zebraStripes,
  createWebglAddon: () => new WebglAddon()
});
if (zebraStripes) {
  watchTerminalZebraStripes(term);
}

const clipboard: TerminalClipboard = {
  readText: () => navigator.clipboard?.readText() ?? Promise.resolve(''),
  writeText: (value) => navigator.clipboard?.writeText(value) ?? Promise.resolve()
};

const search = createTerminalSearchController(searchAddon, {
  bar: document.querySelector<HTMLElement>('#find') ?? { hidden: true },
  input:
    document.querySelector<HTMLInputElement>('#find-input') ??
    ({ value: '', focus: () => undefined, select: () => undefined } as Pick<
      HTMLInputElement,
      'value' | 'focus' | 'select'
    >),
  focusTerminal: () => term.focus()
});
document.querySelector('#find-input')?.addEventListener('keydown', (event) => {
  search.handleInputKeydown(event as KeyboardEvent);
});
document.querySelector('#find-input')?.addEventListener('input', () => search.findNext());
document.querySelector('#find-prev')?.addEventListener('click', () => search.findPrevious());
document.querySelector('#find-next')?.addEventListener('click', () => search.findNext());
document.querySelector('#find-close')?.addEventListener('click', () => search.close());
document.addEventListener('keydown', (event) => {
  if (isTerminalSearchShortcut(event)) {
    event.preventDefault();
    search.open();
  }
});

const keyboardHandler = createTerminalKeyboardHandler(term, {
  clipboard,
  sendInput: (data) => vscode.postMessage({ type: 'input', payload: data })
});
term.attachCustomKeyEventHandler((event) => {
  if (isTerminalSearchShortcut(event)) {
    search.open();
    return false;
  }
  return keyboardHandler(event);
});
if (term.textarea) {
  installTerminalClipboardPasteHandler(term, term.textarea);
}

installTerminalFocusRecovery(term, {
  container,
  document,
  setTimeout: window.setTimeout.bind(window)
});

term.onData((data) => {
  vscode.postMessage({ type: 'input', payload: data });
});

let lastCols = 0;
let lastRows = 0;
let fitFrame = 0;

function fitAndNotify(force = false): void {
  fitAddon.fit();
  if (!force && term.cols === lastCols && term.rows === lastRows) {
    return;
  }
  lastCols = term.cols;
  lastRows = term.rows;
  vscode.postMessage({ type: force ? 'ready' : 'resize', rows: term.rows, cols: term.cols });
}

function scheduleFit(force = false): void {
  if (fitFrame) {
    cancelAnimationFrame(fitFrame);
  }
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    fitAndNotify(force);
  });
}

const resizeObserver = new ResizeObserver(() => {
  scheduleFit();
});
resizeObserver.observe(container);
window.addEventListener('resize', () => scheduleFit());

const reconnectButton = document.querySelector<HTMLButtonElement>('#reconnect');
reconnectButton?.addEventListener('click', () => {
  vscode.postMessage({ type: 'reconnect' });
});

// The decoder is stateful (stream: true) so multi-byte GBK/Big5 sequences split across
// chunks survive; it must be created once, not per message.
const outputOptions: TerminalOutputOptions = {
  semanticHighlight: container.dataset.semanticHighlight === 'true',
  decodeBytes: createTerminalByteDecoder(container.dataset.encoding),
  acknowledge: (bytes) => vscode.postMessage({ type: 'ack', bytes })
};

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; payload?: unknown };
  writeTerminalOutputMessage(message, term, outputOptions);
  if (message.type === 'status' && status) {
    const payload = message.payload as { state?: unknown; text?: unknown } | string | undefined;
    const statusText =
      typeof payload === 'string' ? payload : typeof payload?.text === 'string' ? payload.text : '';
    const text = status.querySelector<HTMLElement>('.terminal-status-text');
    if (text) {
      text.textContent = statusText;
    } else {
      status.textContent = statusText;
    }
    const statusClass = resolveTerminalStatusClass(typeof payload === 'object' ? payload?.state : undefined);
    status.classList.toggle('terminal-status--connected', statusClass === 'connected');
    status.classList.toggle('terminal-status--disconnected', statusClass === 'disconnected');
    status.classList.toggle('terminal-status--connecting', statusClass === 'connecting');
    if (reconnectButton) {
      reconnectButton.hidden = statusClass !== 'disconnected';
    }
  }
});

scheduleFit(true);
