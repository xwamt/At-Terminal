import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { createVscodeKeyboardInteractivePrompt } from '../ssh/VscodeKeyboardInteractivePrompt';
import { SshSession } from '../ssh/SshSession';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { showTimedNotification } from '../utils/notifications';
import { renderWebviewHtml, type WebviewAsset } from './html';
import { TerminalOutputBatcher } from './TerminalOutputBatcher';
import { t } from '../i18n/t';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'ack'; bytes: number }
  | { type: 'reconnect' };

interface TerminalSessionLike {
  write(data: string): void;
  resize(rows: number, cols: number): void;
}

export type TerminalConnectionState = 'connected' | 'disconnected' | 'connecting';

export interface TerminalStatus {
  state: TerminalConnectionState;
  text: string;
}

/** SshSession may still emit plain strings until it is migrated to structured statuses. */
export type SessionStatusEvent = string | TerminalStatus;

export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
  semanticHighlight: boolean;
  idleDisconnectMinutes: number;
  zebraStripes: boolean;
  sessionLogDirectory: string;
  encoding: string;
}

export interface ConfigurationLike {
  get<T>(key: string, defaultValue: T): T;
}

export const TERMINAL_FLOW_PAUSE_BYTES = 512 * 1024;
export const TERMINAL_FLOW_RESUME_BYTES = 128 * 1024;
export const TERMINAL_FLOW_RESUME_TIMEOUT_MS = 5_000;

export interface FlowControlledOutput {
  pauseOutput?(): void;
  resumeOutput?(): void;
}

export interface TerminalFlowControllerOptions {
  pauseAboveBytes?: number;
  resumeBelowBytes?: number;
  resumeTimeoutMs?: number;
}

/**
 * Webview-ack based backpressure. Bytes count as in-flight from `postMessage` until xterm's
 * write callback acks them; past the high-water mark the SSH stream is paused so a busy
 * remote command cannot queue unbounded output the renderer has not consumed yet.
 */
export class TerminalFlowController {
  private readonly pauseAboveBytes: number;
  private readonly resumeBelowBytes: number;
  private readonly resumeTimeoutMs: number;
  private inflightBytes = 0;
  private paused = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly session: FlowControlledOutput,
    options: TerminalFlowControllerOptions = {}
  ) {
    this.pauseAboveBytes = options.pauseAboveBytes ?? TERMINAL_FLOW_PAUSE_BYTES;
    this.resumeBelowBytes = options.resumeBelowBytes ?? TERMINAL_FLOW_RESUME_BYTES;
    this.resumeTimeoutMs = options.resumeTimeoutMs ?? TERMINAL_FLOW_RESUME_TIMEOUT_MS;
  }

  onEmitted(bytes: number): void {
    this.inflightBytes += bytes;
    if (!this.paused && this.inflightBytes > this.pauseAboveBytes) {
      this.paused = true;
      this.session.pauseOutput?.();
      this.armResumeTimeout();
    }
  }

  onAcknowledged(bytes: number): void {
    this.inflightBytes = Math.max(0, this.inflightBytes - bytes);
    if (!this.paused) {
      return;
    }
    if (this.inflightBytes < this.resumeBelowBytes) {
      this.resume();
    } else {
      // Acks are still flowing; push the dead-man timeout forward instead of force-resuming.
      this.armResumeTimeout();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  getInflightBytes(): number {
    return this.inflightBytes;
  }

  dispose(): void {
    this.clearResumeTimeout();
    if (this.paused) {
      this.paused = false;
      this.session.resumeOutput?.();
    }
  }

  private armResumeTimeout(): void {
    this.clearResumeTimeout();
    this.resumeTimer = setTimeout(() => {
      // A reloaded webview never acks bytes the old page received, so without this timeout
      // the remote shell would stay paused forever.
      this.inflightBytes = 0;
      this.resume();
    }, this.resumeTimeoutMs);
  }

  private resume(): void {
    this.clearResumeTimeout();
    this.paused = false;
    this.session.resumeOutput?.();
  }

  private clearResumeTimeout(): void {
    if (!this.resumeTimer) {
      return;
    }
    clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }
}

export interface SessionLogStream {
  write(chunk: Uint8Array): void;
  end(): void;
}

export interface SessionLogIo {
  mkdir(path: string): void;
  createStream(path: string): SessionLogStream;
}

const defaultSessionLogIo: SessionLogIo = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  createStream: (path) => {
    const stream = createWriteStream(path, { flags: 'a' });
    // A full disk or revoked permission must never crash the extension host; the writer
    // stops logging on its next append instead.
    stream.on('error', () => undefined);
    return stream;
  }
};

export function resolveSessionLogFileName(server: Pick<ServerConfig, 'label' | 'id'>): string {
  const label = server.label
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return `${label || 'session'}-${server.id}.log`;
}

/** Appends raw session output to `<directory>/<label>-<id>.log`; disabled after the first I/O failure. */
export class SessionLogWriter {
  private stream: SessionLogStream | undefined;
  private failed = false;

  constructor(
    private readonly directory: string,
    private readonly server: Pick<ServerConfig, 'label' | 'id'>,
    private readonly io: SessionLogIo = defaultSessionLogIo
  ) {}

  append(data: Uint8Array): void {
    if (this.failed) {
      return;
    }
    try {
      if (!this.stream) {
        this.io.mkdir(this.directory);
        this.stream = this.io.createStream(join(this.directory, resolveSessionLogFileName(this.server)));
      }
      this.stream.write(data);
    } catch {
      this.failed = true;
    }
  }

  dispose(): void {
    try {
      this.stream?.end();
    } catch {
      // Stream teardown after an I/O error may throw again; the terminal must not care.
    }
    this.stream = undefined;
  }
}

/**
 * Bridge for sessions that still report plain-string statuses: known English strings and the
 * localized 已断开连接 map onto structured states so the webview never has to parse copy.
 * Structured statuses pass through untouched.
 */
export function normalizeSessionStatus(status: SessionStatusEvent): TerminalStatus {
  if (typeof status !== 'string') {
    return status;
  }
  return { state: resolveStatusStateFromText(status), text: status };
}

function resolveStatusStateFromText(text: string): TerminalConnectionState {
  if (text === 'Connected') {
    return 'connected';
  }
  if (/disconnected/i.test(text) || text.includes('已断开')) {
    return 'disconnected';
  }
  return 'connecting';
}

export const TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS = 3;
export const TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS = 1_000;

/**
 * ssh2 reports a rejected host key as a handshake failure. Retrying cannot succeed until the
 * user trusts or forgets the key, so auto-reconnect must stop instead of re-prompting.
 */
export function isHostVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /host (?:denied|fingerprint)|verification failed/i.test(message);
}

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private static readonly panels = new Set<TerminalPanel>();
  private session: SshSession;
  private readonly terminalId = randomUUID();
  private connected = false;
  private disposed = false;
  private connectionGeneration = 0;
  private idleDisconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private outputBatcher: TerminalOutputBatcher | undefined;
  private flowController: TerminalFlowController | undefined;
  private readonly sessionLog: SessionLogWriter | undefined;
  private autoReconnectAttempts = 0;
  private autoReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private userDisconnected = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly settings: TerminalSettings,
    private readonly hostKeyVerifier: HostKeyVerifier,
    private readonly terminalContext?: TerminalContextRegistry
  ) {
    const logDirectory = settings.sessionLogDirectory.trim();
    this.sessionLog = logDirectory ? new SessionLogWriter(logDirectory, server) : undefined;
    this.session = this.createSession(this.connectionGeneration);
    TerminalPanel.panels.add(this);
  }

  static open(
    context: vscode.ExtensionContext,
    server: ServerConfig,
    configManager: ConfigManager,
    hostKeyVerifier: HostKeyVerifier,
    terminalContext?: TerminalContextRegistry
  ): TerminalPanel {
    const panel = vscode.window.createWebviewPanel(
      'sshTerminal',
      t('SSH: {label}', { label: server.label }),
      createTerminalViewColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('sshManager'), server);
    const terminal = new TerminalPanel(panel, server, configManager, settings, hostKeyVerifier, terminalContext);
    TerminalPanel.active = terminal;
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      createTerminalAssets(context.extensionUri),
      renderTerminalBody(settings)
    );
    terminal.bind();
    terminal.publishContext();
    void terminal.connect();
    return terminal;
  }

  static getActive(): TerminalPanel | undefined {
    return TerminalPanel.active;
  }

  static updateServer(server: ServerConfig): void {
    for (const terminal of TerminalPanel.panels) {
      if (terminal.server.id === server.id) {
        terminal.updateServer(server);
      }
    }
  }

  updateServer(server: ServerConfig): void {
    this.server = server;
    this.publishContext();
  }

  static disconnectAll(): void {
    for (const terminal of Array.from(TerminalPanel.panels)) {
      terminal.disconnect();
    }
    TerminalPanel.panels.clear();
    TerminalPanel.active = undefined;
  }

  async connect(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.userDisconnected = false;
      this.autoReconnectAttempts = 0;
      // publishContext (not markConnected): markConnected no-ops when the terminal is not
      // in the registry yet, leaving MCP tools blind to a live UI connection.
      this.publishContext();
      this.scheduleIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.publishContext();
      this.clearIdleDisconnect();
      this.postStatus({ state: 'disconnected', text: formatError(error) });
    }
  }

  async reconnect(options: { auto?: boolean } = {}): Promise<void> {
    this.clearAutoReconnectTimer();
    if (!options.auto) {
      this.autoReconnectAttempts = 0;
    }
    this.userDisconnected = false;
    const generation = ++this.connectionGeneration;
    try {
      this.postStatus({ state: 'connecting', text: t('Reconnecting...') });
      this.session.dispose();
      this.session = this.createSession(generation);
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.autoReconnectAttempts = 0;
      this.publishContext();
      this.scheduleIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.publishContext();
      this.clearIdleDisconnect();
      this.postStatus({ state: 'disconnected', text: formatError(error) });
      if (isHostVerificationError(error)) {
        // Never loosen host key checks to get reconnected; the user has to resolve trust first.
        this.postTerminalNotice(t('Reconnect stopped: host key verification failed.'));
        return;
      }
      if (options.auto) {
        this.scheduleAutoReconnect();
      }
    }
  }

  disconnect(): void {
    this.disconnectWithStatus(t('Disconnected'), t('Connection disconnected'));
  }

  private disconnectWithStatus(statusMessage: string, terminalNotice: string): void {
    this.connectionGeneration++;
    this.userDisconnected = true;
    this.clearAutoReconnectTimer();
    this.clearIdleDisconnect();
    this.session.dispose();
    this.outputBatcher?.dispose();
    this.flowController?.dispose();
    this.connected = false;
    this.publishContext();
    this.postStatus({ state: 'disconnected', text: statusMessage });
    this.postTerminalNotice(terminalNotice);
  }


  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      if (message.type === 'ack') {
        if (typeof message.bytes === 'number' && Number.isFinite(message.bytes)) {
          this.flowController?.onAcknowledged(message.bytes);
        }
        return;
      }
      if (message.type === 'reconnect') {
        void this.reconnect();
        return;
      }
      if (handleTerminalMessage(message, this.session)) {
        this.scheduleIdleDisconnect();
      }
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
        this.publishContext();
      }
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.connectionGeneration++;
      this.clearAutoReconnectTimer();
      this.clearIdleDisconnect();
      this.session.dispose();
      this.outputBatcher?.dispose();
      this.flowController?.dispose();
      this.sessionLog?.dispose();
      this.connected = false;
      this.terminalContext?.clearIfActive(this.terminalId);
      TerminalPanel.panels.delete(this);
      if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
      }
    });
  }

  private createSession(generation: number): SshSession {
    this.outputBatcher?.dispose();
    this.flowController?.dispose();
    const outputBatcher = new TerminalOutputBatcher({
      emit: (payload) => {
        this.flowController?.onEmitted(payload.byteLength);
        this.postWebviewMessage({ type: 'outputBytes', payload });
      }
    });
    this.outputBatcher = outputBatcher;
    const session = new SshSession(
      this.server,
      this.configManager,
      {
        output: (data) => {
          this.sessionLog?.append(data);
          outputBatcher.push(data);
        },
        status: (message) => this.handleSessionStatus(message, generation),
        error: (error) => this.postStatus({ state: 'disconnected', text: formatError(error) })
      },
      this.hostKeyVerifier,
      createVscodeKeyboardInteractivePrompt()
    );
    this.flowController = new TerminalFlowController(session);
    return session;
  }

  private postStatus(status: TerminalStatus): void {
    this.postWebviewMessage({ type: 'status', payload: status });
  }

  private postTerminalNotice(message: string): void {
    // Notices are a separate message type, so buffered bytes must land first or the notice
    // would be rendered in the middle of the output that preceded it.
    this.outputBatcher?.flush();
    this.postWebviewMessage({ type: 'output', payload: formatTerminalNotice(message) });
  }

  private handleSessionStatus(message: SessionStatusEvent, generation: number): void {
    const status = normalizeSessionStatus(message);
    if (status.state === 'disconnected' && generation === this.connectionGeneration) {
      const wasConnected = this.connected;
      this.connected = false;
      this.publishContext();
      this.clearIdleDisconnect();
      this.postTerminalNotice(t('Connection disconnected'));
      if (wasConnected) {
        this.scheduleAutoReconnect();
      }
    }
    this.postStatus(status);
  }

  private scheduleAutoReconnect(): void {
    if (this.disposed || this.userDisconnected || this.autoReconnectTimer) {
      return;
    }
    if (this.autoReconnectAttempts >= TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS) {
      this.postTerminalNotice(
        t('Automatic reconnect stopped after {max} attempt(s). Use the Reconnect button to retry.', {
          max: TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS
        })
      );
      return;
    }
    const attempt = this.autoReconnectAttempts + 1;
    const delayMs = TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
    this.postTerminalNotice(
      t('Connection lost. Reconnecting in {seconds} second(s) (attempt {attempt} of {max})...', {
        seconds: delayMs / 1000,
        attempt,
        max: TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS
      })
    );
    this.autoReconnectTimer = setTimeout(() => {
      this.autoReconnectTimer = undefined;
      this.autoReconnectAttempts = attempt;
      void this.reconnect({ auto: true });
    }, delayMs);
  }

  private clearAutoReconnectTimer(): void {
    if (!this.autoReconnectTimer) {
      return;
    }
    clearTimeout(this.autoReconnectTimer);
    this.autoReconnectTimer = undefined;
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleDisconnect();
    if (!this.connected || this.settings.idleDisconnectMinutes <= 0) {
      return;
    }
    this.idleDisconnectTimer = setTimeout(() => {
      const message = t('Disconnected after {minutes} minute(s) of inactivity.', {
        minutes: this.settings.idleDisconnectMinutes
      });
      this.disconnectWithStatus(message, message);
      showTimedNotification(message, 'warning');
    }, this.settings.idleDisconnectMinutes * 60_000);
  }

  private clearIdleDisconnect(): void {
    if (!this.idleDisconnectTimer) {
      return;
    }
    clearTimeout(this.idleDisconnectTimer);
    this.idleDisconnectTimer = undefined;
  }

  private publishContext(): void {
    this.terminalContext?.setActive({
      terminalId: this.terminalId,
      server: this.server,
      connected: this.connected,
      write: (data) => this.session.write(data)
    });
  }

  private postWebviewMessage(message: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
    } catch {
      // VS Code can reject or throw if a late SSH event arrives after webview disposal.
    }
  }
}

export function resolveTerminalSettings(
  configuration: ConfigurationLike,
  server?: Pick<ServerConfig, 'encoding'>
): TerminalSettings {
  return {
    scrollback: configuration.get('scrollback', 10000),
    fontSize: configuration.get('terminalFontSize', 14),
    fontFamily: configuration.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace'),
    semanticHighlight: configuration.get('semanticHighlight', true),
    idleDisconnectMinutes: configuration.get('idleDisconnectMinutes', 60),
    zebraStripes: configuration.get('zebraStripes', false),
    sessionLogDirectory: configuration.get('sessionLogDirectory', ''),
    encoding: server?.encoding ?? 'utf-8'
  };
}

export function createTerminalAssets(extensionUri: vscode.Uri): WebviewAsset {
  return {
    script: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'terminal.js'),
    style: vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'terminal.css')
  };
}

export function createTerminalViewColumn(): vscode.ViewColumn {
  return vscode.ViewColumn.Active;
}

export function renderTerminalBody(settings: TerminalSettings): string {
  return `<main class="terminal-shell">
  <header class="terminal-status terminal-status--connecting" id="status" role="status" aria-live="polite">
    <span class="terminal-status-dot"></span>
    <span class="terminal-status-text">${escapeAttr(t('Starting...'))}</span>
    <button type="button" id="reconnect" class="terminal-reconnect" hidden>${escapeAttr(t('Reconnect'))}</button>
    <div id="find" class="terminal-find" hidden>
      <input id="find-input" class="terminal-find-input" type="text" placeholder="${escapeAttr(t('Find'))}" aria-label="${escapeAttr(t('Find'))}">
      <button type="button" id="find-prev" class="terminal-find-button" title="${escapeAttr(t('Previous match'))}">&#8593;</button>
      <button type="button" id="find-next" class="terminal-find-button" title="${escapeAttr(t('Next match'))}">&#8595;</button>
      <button type="button" id="find-close" class="terminal-find-button" title="${escapeAttr(t('Close find'))}">&#10005;</button>
    </div>
    <span class="terminal-host">xterm.js</span>
  </header>
  <section id="terminal" class="terminal-surface" data-scrollback="${settings.scrollback}" data-font-size="${settings.fontSize}" data-font-family="${escapeAttr(settings.fontFamily)}" data-semantic-highlight="${settings.semanticHighlight}" data-zebra-stripes="${settings.zebraStripes}" data-encoding="${escapeAttr(settings.encoding)}"></section>
</main>`;
}


export function formatTerminalNotice(message: string): string {
  return `\r\n\x1b[31m${message}\x1b[0m\r\n`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function handleTerminalMessage(message: TerminalMessage, session: TerminalSessionLike): boolean {
  if (message.type === 'input' && typeof message.payload === 'string') {
    session.write(message.payload);
    return true;
  }
  if (message.type === 'ready' || message.type === 'resize') {
    session.resize(message.rows, message.cols);
    return true;
  }
  return false;
}
