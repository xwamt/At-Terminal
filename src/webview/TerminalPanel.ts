import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import type { ServerConfig } from '../config/schema';
import { SshSession, type HostKeyVerifier } from '../ssh/SshSession';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type TerminalMessage =
  | { type: 'ready'; rows: number; cols: number }
  | { type: 'input'; payload: string }
  | { type: 'resize'; rows: number; cols: number };

export class TerminalPanel {
  private static active: TerminalPanel | undefined;
  private session: SshSession;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly server: ServerConfig,
    private readonly configManager: ConfigManager,
    private readonly hostKeyVerifier?: HostKeyVerifier
  ) {
    this.session = this.createSession();
  }

  static open(
    context: vscode.ExtensionContext,
    server: ServerConfig,
    configManager: ConfigManager,
    hostKeyVerifier?: HostKeyVerifier
  ): TerminalPanel {
    const panel = vscode.window.createWebviewPanel(
      'sshTerminal',
      `SSH: ${server.label}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri]
      }
    );

    const terminal = new TerminalPanel(panel, server, configManager, hostKeyVerifier);
    TerminalPanel.active = terminal;
    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'terminal.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'terminal', 'index.css')
      },
      `<div id="status">Starting...</div><div id="terminal" data-scrollback="5000" data-font-size="14" data-font-family="Cascadia Code, Menlo, monospace"></div>`
    );
    terminal.bind();
    void terminal.connect();
    return terminal;
  }

  static getActive(): TerminalPanel | undefined {
    return TerminalPanel.active;
  }

  async connect(): Promise<void> {
    try {
      await this.session.connect();
    } catch (error) {
      this.postStatus(formatError(error));
    }
  }

  async reconnect(): Promise<void> {
    try {
      this.postStatus('Reconnecting...');
      await this.session.reconnect();
    } catch (error) {
      this.postStatus(formatError(error));
    }
  }

  disconnect(): void {
    this.session.dispose();
    this.postStatus('Disconnected');
  }

  private bind(): void {
    this.panel.webview.onDidReceiveMessage((message: TerminalMessage) => {
      if (message.type === 'input' && typeof message.payload === 'string') {
        this.session.write(message.payload);
      }
      if (message.type === 'resize') {
        this.session.resize(message.rows, message.cols);
      }
    });

    this.panel.onDidChangeViewState((event) => {
      if (event.webviewPanel.active) {
        TerminalPanel.active = this;
      }
    });

    this.panel.onDidDispose(() => {
      this.session.dispose();
      if (TerminalPanel.active === this) {
        TerminalPanel.active = undefined;
      }
    });
  }

  private createSession(): SshSession {
    return new SshSession(
      this.server,
      this.configManager,
      {
        output: (data) => {
          void this.panel.webview.postMessage({ type: 'output', payload: data });
        },
        status: (message) => this.postStatus(message),
        error: (error) => this.postStatus(formatError(error))
      },
      this.hostKeyVerifier
    );
  }

  private postStatus(message: string): void {
    void this.panel.webview.postMessage({ type: 'status', payload: message });
  }
}
