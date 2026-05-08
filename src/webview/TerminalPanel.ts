import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { LrzszDetector } from '../lrzsz/LrzszDetector';
import { LrzszTransfer } from '../lrzsz/LrzszTransfer';
import type { HostKeyVerifier } from '../ssh/SshConnectionConfig';
import { SshSession } from '../ssh/SshSession';
import type { TerminalContextRegistry } from '../terminal/TerminalContext';
import { formatError } from '../utils/errors';
import { renderWebviewHtml, type WebviewAsset } from './html';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number };

interface TerminalSessionLike {
  write(data: string): void;
  resize(rows: number, cols: number): void;
}

export interface TerminalSettings {
  scrollback: number;
  fontSize: number;
  fontFamily: string;
  semanticHighlight: boolean;
  idleDisconnectMinutes: number;
}

export interface ConfigurationLike {
  get<T>(key: string, defaultValue: T): T;
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

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly settings: TerminalSettings,
    private readonly hostKeyVerifier?: HostKeyVerifier,
    private readonly terminalContext?: TerminalContextRegistry
  ) {
    this.session = this.createSession(this.connectionGeneration);
    TerminalPanel.panels.add(this);
  }

  static open(
    context: vscode.ExtensionContext,
    server: ServerConfig,
    configManager: ConfigManager,
    hostKeyVerifier?: HostKeyVerifier,
    terminalContext?: TerminalContextRegistry
  ): TerminalPanel {
    const panel = vscode.window.createWebviewPanel(
      'sshTerminal',
      `SSH: ${server.label}`,
      createTerminalViewColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('sshManager'));
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
      this.terminalContext?.markConnected(this.terminalId);
      this.scheduleIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postStatus(formatError(error));
    }
  }

  async reconnect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    try {
      this.postStatus('Reconnecting...');
      this.session.dispose();
      this.session = this.createSession(generation);
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.terminalContext?.markConnected(this.terminalId);
      this.scheduleIdleDisconnect();
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postStatus(formatError(error));
    }
  }

  disconnect(): void {
    this.disconnectWithStatus('Disconnected', '连接已断开');
  }

  private disconnectWithStatus(statusMessage: string, terminalNotice: string): void {
    this.connectionGeneration++;
    this.clearIdleDisconnect();
    this.session.dispose();
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.postStatus(statusMessage);
    this.postTerminalNotice(terminalNotice);
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
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
      this.clearIdleDisconnect();
      this.session.dispose();
      this.connected = false;
      this.terminalContext?.clearIfActive(this.terminalId);
      TerminalPanel.panels.delete(this);
      if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
      }
    });
  }

  private createSession(generation: number): SshSession {
    const lrzszDetector = new LrzszDetector({
      onTransfer: (start) => {
        void new LrzszTransfer().start(start);
      }
    });
    return new SshSession(
      this.server,
      this.configManager,
      {
        output: (data) => {
          const inspected = lrzszDetector.inspect(data.toString('latin1'));
          if (inspected.passthrough) {
            this.postWebviewMessage({ type: 'outputBytes', payload: [...data] });
          }
        },
        status: (message) => this.handleSessionStatus(message, generation),
        error: (error) => this.postStatus(formatError(error))
      },
      this.hostKeyVerifier
    );
  }

  private postStatus(message: string): void {
    this.postWebviewMessage({ type: 'status', payload: message });
  }

  private postTerminalNotice(message: string): void {
    this.postWebviewMessage({ type: 'output', payload: formatTerminalNotice(message) });
  }

  private handleSessionStatus(message: string, generation: number): void {
    if (message === 'Disconnected' && generation === this.connectionGeneration) {
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.clearIdleDisconnect();
      this.postTerminalNotice('连接已断开');
    }
    this.postStatus(message);
  }

  private scheduleIdleDisconnect(): void {
    this.clearIdleDisconnect();
    if (!this.connected || this.settings.idleDisconnectMinutes <= 0) {
      return;
    }
    this.idleDisconnectTimer = setTimeout(() => {
      const message = `空闲时间超过${this.settings.idleDisconnectMinutes}分钟，断开连接`;
      this.disconnectWithStatus(message, message);
      void vscode.window.showWarningMessage(message);
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

export function resolveTerminalSettings(configuration: ConfigurationLike): TerminalSettings {
  return {
    scrollback: configuration.get('scrollback', 5000),
    fontSize: configuration.get('terminalFontSize', 14),
    fontFamily: configuration.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace'),
    semanticHighlight: configuration.get('semanticHighlight', true),
    idleDisconnectMinutes: configuration.get('idleDisconnectMinutes', 60)
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
    <span class="terminal-status-text">Starting...</span>
    <span class="terminal-host">xterm.js</span>
  </header>
  <section id="terminal" class="terminal-surface" data-scrollback="${settings.scrollback}" data-font-size="${settings.fontSize}" data-font-family="${escapeAttr(settings.fontFamily)}" data-semantic-highlight="${settings.semanticHighlight}"></section>
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
