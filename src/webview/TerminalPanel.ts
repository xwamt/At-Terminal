import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { LrzszDetector } from '../lrzsz/LrzszDetector';
import { LrzszTransfer } from '../lrzsz/LrzszTransfer';
import { SshSession, type HostKeyVerifier } from '../ssh/SshSession';
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
}

export interface ConfigurationLike {
  get<T>(key: string, defaultValue: T): T;
}

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private session: SshSession;
  private readonly terminalId = randomUUID();
  private connected = false;
  private connectionGeneration = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier?: HostKeyVerifier,
    private readonly terminalContext?: TerminalContextRegistry
  ) {
    this.session = this.createSession(this.connectionGeneration);
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

    const terminal = new TerminalPanel(panel, server, configManager, hostKeyVerifier, terminalContext);
    TerminalPanel.active = terminal;
    const settings = resolveTerminalSettings(vscode.workspace.getConfiguration('sshManager'));
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

  async connect(): Promise<void> {
    const generation = this.connectionGeneration;
    try {
      await this.session.connect();
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = true;
      this.terminalContext?.markConnected(this.terminalId);
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
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
    } catch (error) {
      if (generation !== this.connectionGeneration) {
        return;
      }
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
      this.postStatus(formatError(error));
    }
  }

  disconnect(): void {
    this.connectionGeneration++;
    this.session.dispose();
    this.connected = false;
    this.terminalContext?.markDisconnected(this.terminalId);
    this.postStatus('Disconnected');
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      handleTerminalMessage(message, this.session);
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
        this.publishContext();
      }
    });

    this.panel.onDidDispose(() => {
      this.connectionGeneration++;
      this.session.dispose();
      this.connected = false;
      this.terminalContext?.clearIfActive(this.terminalId);
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
          const inspected = lrzszDetector.inspect(data);
          if (inspected.passthrough) {
            void this.panel.webview.postMessage({ type: 'output', payload: inspected.passthrough });
          }
        },
        status: (message) => this.handleSessionStatus(message, generation),
        error: (error) => this.postStatus(formatError(error))
      },
      this.hostKeyVerifier
    );
  }

  private postStatus(message: string): void {
    void this.panel.webview.postMessage({ type: 'status', payload: message });
  }

  private handleSessionStatus(message: string, generation: number): void {
    if (message === 'Disconnected' && generation === this.connectionGeneration) {
      this.connected = false;
      this.terminalContext?.markDisconnected(this.terminalId);
    }
    this.postStatus(message);
  }

  private publishContext(): void {
    this.terminalContext?.setActive({
      terminalId: this.terminalId,
      server: this.server,
      connected: this.connected,
      write: (data) => this.session.write(data)
    });
  }
}

export function resolveTerminalSettings(configuration: ConfigurationLike): TerminalSettings {
  return {
    scrollback: configuration.get('scrollback', 5000),
    fontSize: configuration.get('terminalFontSize', 14),
    fontFamily: configuration.get('terminalFontFamily', 'Cascadia Code, Menlo, monospace')
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
  <header class="terminal-status terminal-status--connecting" id="status">
    <span class="terminal-status-dot"></span>
    <span class="terminal-status-text">Starting...</span>
    <span class="terminal-host">xterm.js</span>
  </header>
  <section id="terminal" class="terminal-surface" data-scrollback="${settings.scrollback}" data-font-size="${settings.fontSize}" data-font-family="${escapeAttr(settings.fontFamily)}"></section>
</main>`;
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
