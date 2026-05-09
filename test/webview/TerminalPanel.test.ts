import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ServerConfig } from '../../src/config/schema';
import { deactivate } from '../../src/extension';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import {
  createTerminalAssets,
  createTerminalViewColumn,
  formatTerminalNotice,
  handleTerminalMessage,
  renderTerminalBody,
  resolveTerminalSettings,
  TerminalPanel
} from '../../src/webview/TerminalPanel';

const connect = vi.fn<() => Promise<void>>();
const reconnect = vi.fn<() => Promise<void>>();
const disposeSession = vi.fn<() => void>();
const write = vi.fn<(data: string) => void>();
const resize = vi.fn<(rows: number, cols: number) => void>();
const sessionEvents: Array<{ output(data: Buffer): void; status(message: string): void }> = [];

vi.mock('../../src/ssh/SshSession', () => ({
  SshSession: vi.fn().mockImplementation((_server, _configManager, events) => {
    sessionEvents.push(events);
    return {
      connect,
      reconnect,
      dispose: disposeSession,
      write,
      resize
    };
  })
}));

function server(id = 'terminal-server'): ServerConfig {
  return {
    id,
    label: id,
    host: `${id}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

function configManager() {
  return {} as never;
}

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('extension-root')
  } as vscode.ExtensionContext;
}

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const viewStateListeners: Array<(event: { webviewPanel: { active: boolean } }) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel = {
    active: true,
    webview: {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn()
    },
    onDidChangeViewState: vi.fn((listener: (event: { webviewPanel: { active: boolean } }) => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    })
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    fireViewState(active: boolean) {
      for (const listener of viewStateListeners) {
        listener({ webviewPanel: { active } });
      }
    },
    fireDispose() {
      for (const listener of disposeListeners) {
        listener();
      }
    }
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  deactivate();
  connect.mockResolvedValue(undefined);
  reconnect.mockResolvedValue(undefined);
  disposeSession.mockClear();
  write.mockClear();
  resize.mockClear();
  sessionEvents.length = 0;
  vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(createPanel().panel);
});

describe('TerminalPanel rendering helpers', () => {
  it('links the bundled xterm stylesheet emitted by esbuild', () => {
    const assets = createTerminalAssets({ fsPath: 'extension-root' } as never);

    expect(assets.style).toBeDefined();
    expect(assets.style!.fsPath).toBe('extension-root/dist/webview/terminal.css');
  });

  it('opens new terminal panels as tabs in the active editor group', () => {
    expect(createTerminalViewColumn()).toBe(vscode.ViewColumn.Active);
  });

  it('renders terminal settings into the webview data attributes', () => {
    const body = renderTerminalBody({
      scrollback: 1234,
      fontSize: 16,
      fontFamily: 'JetBrains Mono',
      semanticHighlight: true,
      idleDisconnectMinutes: 60
    });

    expect(body).toContain('data-scrollback="1234"');
    expect(body).toContain('data-font-size="16"');
    expect(body).toContain('data-font-family="JetBrains Mono"');
    expect(body).toContain('data-semantic-highlight="true"');
  });

  it('reads contributed terminal settings from VS Code configuration', () => {
    const settings = resolveTerminalSettings({
      get: <T>(key: string, defaultValue: T): T => {
        const values: Record<string, unknown> = {
          scrollback: 9000,
          terminalFontSize: 18,
          terminalFontFamily: 'Fira Code',
          semanticHighlight: false
        };
        return (values[key] ?? defaultValue) as T;
      }
    });

    expect(settings).toEqual({
      scrollback: 9000,
      fontSize: 18,
      fontFamily: 'Fira Code',
      semanticHighlight: false,
      idleDisconnectMinutes: 60
    });
  });

  it('treats ready messages as resize messages so the remote PTY matches xterm', () => {
    const session = {
      write: vi.fn(),
      resize: vi.fn()
    };

    expect(handleTerminalMessage({ type: 'ready', rows: 42, cols: 132 }, session)).toBe(true);
    expect(session.resize).toHaveBeenCalledWith(42, 132);
  });

  it('renders a full-bleed xterm surface with semantic status regions', () => {
    const body = renderTerminalBody({
      scrollback: 5000,
      fontSize: 14,
      fontFamily: 'Cascadia Code',
      semanticHighlight: true,
      idleDisconnectMinutes: 60
    });

    expect(body).toContain('class="terminal-shell"');
    expect(body).toContain('class="terminal-status terminal-status--connecting"');
    expect(body).toContain('role="status"');
    expect(body).not.toContain('id="disconnectNotice"');
    expect(body).not.toContain('class="terminal-disconnect-notice"');
    expect(body).toContain('class="terminal-host"');
  });

  it('formats terminal notices as red terminal output', () => {
    expect(formatTerminalNotice('Disconnected after 30 minute(s) of inactivity.')).toBe(
      '\r\n\x1b[31mDisconnected after 30 minute(s) of inactivity.\x1b[0m\r\n'
    );
  });

  it('publishes active terminal context as disconnected on open and connected after connect succeeds', async () => {
    const registry = new TerminalContextRegistry();
    const listener = vi.fn();
    registry.onDidChangeActiveContext(listener);

    TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);

    expect(registry.getActive()?.connected).toBe(false);
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);
    expect(registry.getActive()?.server.id).toBe('terminal-server');
    expect(registry.getActive()?.terminalId).toEqual(expect.any(String));
    expect(listener).toHaveBeenLastCalledWith(registry.getActive());
  });

  it('marks the active context disconnected on connect error and disconnect', async () => {
    connect.mockRejectedValueOnce(new Error('connect failed'));
    const registry = new TerminalContextRegistry();

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);

    await flushPromises();
    expect(registry.getActive()?.connected).toBe(false);

    terminal.disconnect();
    expect(registry.getActive()?.connected).toBe(false);
  });

  it('keeps current connection state on duplicate activation and clears on dispose', async () => {
    const registry = new TerminalContextRegistry();
    const listener = vi.fn();
    registry.onDidChangeActiveContext(listener);
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
    await flushPromises();
    listener.mockClear();

    panelHost.fireViewState(true);
    expect(listener).not.toHaveBeenCalled();
    expect(registry.getActive()?.connected).toBe(true);

    panelHost.fireDispose();
    expect(registry.getActive()).toBeUndefined();
  });

  it('ignores connect success after the terminal has been disconnected', async () => {
    const pendingConnect = deferred<void>();
    connect.mockReturnValueOnce(pendingConnect.promise);
    const registry = new TerminalContextRegistry();

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
    terminal.disconnect();

    expect(registry.getActive()?.connected).toBe(false);
    pendingConnect.resolve();
    await flushPromises();

    expect(registry.getActive()?.connected).toBe(false);
  });

  it('marks the active context disconnected when the remote session reports Disconnected status', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);

    sessionEvents.at(-1)!.status('Disconnected');

    expect(registry.getActive()?.connected).toBe(false);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({ type: 'status', payload: 'Disconnected' });
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'output',
      payload: '\r\n\x1b[31mConnection disconnected\x1b[0m\r\n'
    });
  });

  it('disconnects an idle terminal after the configured timeout', async () => {
    try {
      vi.useFakeTimers();
      vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
      vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: <T>(key: string, defaultValue: T): T => {
          const values: Record<string, unknown> = {
            idleDisconnectMinutes: 1
          };
          return (values[key] ?? defaultValue) as T;
        }
      } as never);
      const registry = new TerminalContextRegistry();

      TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
      await flushPromises();

      vi.advanceTimersByTime(60_000);

      expect(disposeSession).toHaveBeenCalledTimes(1);
      expect(registry.getActive()?.connected).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Disconnected after 1 minute(s) of inactivity.'
      );
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalledWith(
        expect.stringMatching(/[^\x00-\x7F]/)
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects all terminal sessions when the extension deactivates', async () => {
    const firstPanelHost = createPanel();
    const secondPanelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel)
      .mockReturnValueOnce(firstPanelHost.panel)
      .mockReturnValueOnce(secondPanelHost.panel);

    TerminalPanel.open(extensionContext(), server('first-server'), configManager());
    TerminalPanel.open(extensionContext(), server('second-server'), configManager());
    await flushPromises();

    deactivate();

    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(TerminalPanel.getActive()).toBeUndefined();
  });

  it('posts ANSI terminal output to xterm as raw bytes without stripping escape sequences', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
    const rawOutput = Buffer.from('\x1b[31mred\x1b[0m\r\n\x1b[32mgreen\x1b[0m', 'utf8');

    TerminalPanel.open(extensionContext(), server(), configManager());
    await flushPromises();
    sessionEvents.at(-1)!.output(rawOutput);

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'outputBytes',
      payload: [...rawOutput]
    });
  });

  it('ignores late session messages after the webview panel is disposed', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
    await flushPromises();
    panelHost.fireDispose();
    sessionEvents.at(-1)!.output(Buffer.from('late output', 'utf8'));
    sessionEvents.at(-1)!.status('Disconnected');

    expect(panelHost.panel.webview.postMessage).not.toHaveBeenCalled();
  });

  it('does not let stale disconnected status from an old session mark a reconnected terminal disconnected', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), undefined, registry);
    await flushPromises();
    const oldSessionEvents = sessionEvents[0];

    await terminal.reconnect();
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);

    oldSessionEvents.status('Disconnected');

    expect(registry.getActive()?.connected).toBe(true);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({ type: 'status', payload: 'Disconnected' });
  });
});
