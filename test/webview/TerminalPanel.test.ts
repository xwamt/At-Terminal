import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ServerConfig } from '../../src/config/schema';
import { deactivate } from '../../src/extension';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import { TERMINAL_OUTPUT_FLUSH_BYTES, TERMINAL_OUTPUT_FLUSH_MS } from '../../src/webview/TerminalOutputBatcher';
import {
  createTerminalAssets,
  createTerminalViewColumn,
  formatTerminalNotice,
  handleTerminalMessage,
  isHostVerificationError,
  normalizeSessionStatus,
  renderTerminalBody,
  resolveSessionLogFileName,
  resolveTerminalSettings,
  SessionLogWriter,
  TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS,
  TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS,
  TERMINAL_FLOW_PAUSE_BYTES,
  TerminalFlowController,
  TerminalPanel,
  type SessionStatusEvent,
  type TerminalSettings
} from '../../src/webview/TerminalPanel';

const connect = vi.fn<() => Promise<void>>();
const reconnect = vi.fn<() => Promise<void>>();
const disposeSession = vi.fn<() => void>();
const write = vi.fn<(data: string) => void>();
const resize = vi.fn<(rows: number, cols: number) => void>();
const pauseOutput = vi.fn<() => void>();
const resumeOutput = vi.fn<() => void>();
const sessionEvents: Array<{ output(data: Buffer): void; status(message: SessionStatusEvent): void }> = [];

vi.mock('../../src/ssh/SshSession', () => ({
  SshSession: vi.fn().mockImplementation((_server, _configManager, events) => {
    sessionEvents.push(events);
    return {
      connect,
      reconnect,
      dispose: disposeSession,
      write,
      resize,
      pauseOutput,
      resumeOutput
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

const hostKeyVerifier = { verify: async () => true };

function terminalSettings(overrides: Partial<TerminalSettings> = {}): TerminalSettings {
  return {
    scrollback: 5000,
    fontSize: 14,
    fontFamily: 'Cascadia Code',
    semanticHighlight: true,
    idleDisconnectMinutes: 60,
    zebraStripes: false,
    sessionLogDirectory: '',
    encoding: 'utf-8',
    ...overrides
  };
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
    fireMessage(message: unknown) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
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

function outputMessages(panel: vscode.WebviewPanel): string[] {
  return vi
    .mocked(panel.webview.postMessage)
    .mock.calls.map(([message]) => message as { type?: string; payload?: unknown })
    .filter((message) => message.type === 'outputBytes')
    .map((message) => Buffer.from(message.payload as Uint8Array).toString());
}

function noticeMessages(panel: vscode.WebviewPanel): string[] {
  return vi
    .mocked(panel.webview.postMessage)
    .mock.calls.map(([message]) => message as { type?: string; payload?: unknown })
    .filter((message) => message.type === 'output')
    .map((message) => String(message.payload));
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
  connect.mockReset();
  connect.mockResolvedValue(undefined);
  reconnect.mockResolvedValue(undefined);
  disposeSession.mockClear();
  write.mockClear();
  resize.mockClear();
  pauseOutput.mockClear();
  resumeOutput.mockClear();
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
    const body = renderTerminalBody(
      terminalSettings({
        scrollback: 1234,
        fontSize: 16,
        fontFamily: 'JetBrains Mono',
        zebraStripes: true,
        encoding: 'gbk'
      })
    );

    expect(body).toContain('data-scrollback="1234"');
    expect(body).toContain('data-font-size="16"');
    expect(body).toContain('data-font-family="JetBrains Mono"');
    expect(body).toContain('data-semantic-highlight="true"');
    expect(body).toContain('data-zebra-stripes="true"');
    expect(body).toContain('data-encoding="gbk"');
  });

  it('reads contributed terminal settings from VS Code configuration', () => {
    const settings = resolveTerminalSettings(
      {
        get: <T>(key: string, defaultValue: T): T => {
          const values: Record<string, unknown> = {
            scrollback: 9000,
            terminalFontSize: 18,
            terminalFontFamily: 'Fira Code',
            semanticHighlight: false
          };
          return (values[key] ?? defaultValue) as T;
        }
      },
      server()
    );

    expect(settings).toEqual({
      scrollback: 9000,
      fontSize: 18,
      fontFamily: 'Fira Code',
      semanticHighlight: false,
      idleDisconnectMinutes: 60,
      zebraStripes: false,
      sessionLogDirectory: '',
      encoding: 'utf-8'
    });
  });

  it('falls back to utf-8 when no server encoding is available', () => {
    const settings = resolveTerminalSettings({ get: <T>(_key: string, defaultValue: T): T => defaultValue });

    expect(settings.encoding).toBe('utf-8');
    expect(settings.zebraStripes).toBe(false);
    expect(settings.sessionLogDirectory).toBe('');
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
    const body = renderTerminalBody(terminalSettings());

    expect(body).toContain('class="terminal-shell"');
    expect(body).toContain('class="terminal-status terminal-status--connecting"');
    expect(body).toContain('role="status"');
    expect(body).not.toContain('id="disconnectNotice"');
    expect(body).not.toContain('class="terminal-disconnect-notice"');
    expect(body).toContain('class="terminal-host"');
  });

  it('renders a hidden reconnect button and find bar for the webview to toggle', () => {
    const body = renderTerminalBody(terminalSettings());

    expect(body).toContain('id="reconnect"');
    expect(body).toMatch(/<button[^>]*id="reconnect"[^>]*hidden/);
    expect(body).toContain('id="find"');
    expect(body).toContain('id="find-input"');
    expect(body).toContain('id="find-prev"');
    expect(body).toContain('id="find-next"');
    expect(body).toContain('id="find-close"');
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

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);

    expect(registry.getActive()?.connected).toBe(false);
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);
    expect(registry.getActive()?.server.id).toBe('terminal-server');
    expect(registry.getActive()?.terminalId).toEqual(expect.any(String));
    expect(listener).toHaveBeenLastCalledWith(registry.getActive());
  });

  it('publishes connected context on connect success even if the terminal is not yet registered', async () => {
    const registry = new TerminalContextRegistry();
    const pendingConnect = deferred<void>();
    connect.mockReturnValueOnce(pendingConnect.promise);

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    const terminalId = registry.getActive()!.terminalId;
    // Simulate the registry losing the entry before the connection resolves; the old
    // markConnected call would no-op here and MCP tools would never see the terminal.
    registry.clearIfActive(terminalId);
    expect(registry.getActive()).toBeUndefined();

    pendingConnect.resolve();
    await flushPromises();

    expect(registry.getActive()?.connected).toBe(true);
    expect(registry.getSnapshot().connectedTerminals.map((terminal) => terminal.terminalId)).toEqual([
      terminalId
    ]);
  });

  it('re-registers the terminal context on reconnect after the registry lost it', async () => {
    const registry = new TerminalContextRegistry();

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    await flushPromises();
    const terminalId = registry.getActive()!.terminalId;
    registry.clearIfActive(terminalId);
    expect(registry.getActive()).toBeUndefined();

    await terminal.reconnect();
    await flushPromises();

    expect(registry.getActive()?.connected).toBe(true);
    expect(registry.getSnapshot().connectedTerminals).toHaveLength(1);
  });

  it('publishes registry connected:true when the session reports connected before connect() resolves', async () => {
    const registry = new TerminalContextRegistry();
    const pendingConnect = deferred<void>();
    connect.mockReturnValueOnce(pendingConnect.promise);

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    expect(registry.getActive()?.connected).toBe(false);

    // SshSession emits { state: 'connected' } from inside connect(); the webview shows
    // "Connected" off this status. The registry — what MCP tools and the SFTP view read —
    // must flip with it, not only when the connect() promise tail eventually runs.
    sessionEvents.at(-1)!.status({ state: 'connected', text: 'Connected' });

    expect(registry.getActive()?.connected).toBe(true);
    expect(registry.getSnapshot().connectedTerminals).toHaveLength(1);

    pendingConnect.resolve();
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);
  });

  it('ignores a stale connected status from a superseded session generation', async () => {
    const registry = new TerminalContextRegistry();
    const pendingConnect = deferred<void>();
    connect.mockReturnValueOnce(pendingConnect.promise);

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    const oldSessionEvents = sessionEvents.at(-1)!;
    terminal.disconnect();

    oldSessionEvents.status({ state: 'connected', text: 'Connected' });

    expect(registry.getActive()?.connected).toBe(false);
  });

  it('marks the active context disconnected on connect error and disconnect', async () => {
    connect.mockRejectedValueOnce(new Error('connect failed'));
    const registry = new TerminalContextRegistry();

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);

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

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
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

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    terminal.disconnect();

    expect(registry.getActive()?.connected).toBe(false);
    pendingConnect.resolve();
    await flushPromises();

    expect(registry.getActive()?.connected).toBe(false);
  });

  it('marks the active context disconnected when the remote session reports Disconnected status', async () => {
    try {
      vi.useFakeTimers();
      const registry = new TerminalContextRegistry();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
      await flushPromises();
      expect(registry.getActive()?.connected).toBe(true);

      sessionEvents.at(-1)!.status('Disconnected');

      expect(registry.getActive()?.connected).toBe(false);
      expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'status',
        payload: { state: 'disconnected', text: 'Disconnected' }
      });
      expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'output',
        payload: '\r\n\x1b[31mConnection disconnected\x1b[0m\r\n'
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnects an idle terminal after the configured timeout', async () => {
    try {
      vi.useFakeTimers();
      vi.spyOn(vscode.window, 'withProgress').mockImplementation(async (_options, task) =>
        task({ report: vi.fn() }, {} as never) as never
      );
      vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: <T>(key: string, defaultValue: T): T => {
          const values: Record<string, unknown> = {
            idleDisconnectMinutes: 1
          };
          return (values[key] ?? defaultValue) as T;
        }
      } as never);
      const registry = new TerminalContextRegistry();

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
      await flushPromises();

      vi.advanceTimersByTime(60_000);

      expect(disposeSession).toHaveBeenCalledTimes(1);
      expect(registry.getActive()?.connected).toBe(false);
      expect(vscode.window.withProgress).toHaveBeenCalledWith(
        {
          location: vscode.ProgressLocation.Notification,
          title: '$(warning) Disconnected after 1 minute(s) of inactivity.',
          cancellable: false
        },
        expect.any(Function)
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

    TerminalPanel.open(extensionContext(), server('first-server'), configManager(), hostKeyVerifier);
    TerminalPanel.open(extensionContext(), server('second-server'), configManager(), hostKeyVerifier);
    await flushPromises();

    deactivate();

    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(TerminalPanel.getActive()).toBeUndefined();
  });

  it('posts ANSI terminal output to xterm as binary bytes without stripping escape sequences', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
      const rawOutput = Buffer.from('\x1b[31mred\x1b[0m\r\n\x1b[32mgreen\x1b[0m', 'utf8');

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      sessionEvents.at(-1)!.output(rawOutput);
      vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

      expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'outputBytes',
        payload: Uint8Array.from(rawOutput)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes zmodem sequences straight to xterm so rz and sz stay interruptible', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
      const zmodemHeader = Buffer.from('rz waiting to receive.**\x18B0100000023be50\r\x8a\x11', 'latin1');

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      sessionEvents.at(-1)!.output(zmodemHeader);
      vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

      expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
        type: 'outputBytes',
        payload: Uint8Array.from(zmodemHeader)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces a burst of SSH packets into a single webview message', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      const events = sessionEvents.at(-1)!;
      events.output(Buffer.from('first '));
      events.output(Buffer.from('second '));
      events.output(Buffer.from('third'));
      expect(outputMessages(panelHost.panel)).toEqual([]);

      vi.advanceTimersByTime(TERMINAL_OUTPUT_FLUSH_MS);

      expect(outputMessages(panelHost.panel)).toEqual(['first second third']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes buffered output before the disconnect notice so the tail is not reordered', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      sessionEvents.at(-1)!.output(Buffer.from('last line'));
      terminal.disconnect();

      const posted = vi.mocked(panelHost.panel.webview.postMessage).mock.calls.map(([message]) => message);
      expect(posted).toEqual([
        { type: 'outputBytes', payload: Uint8Array.from(Buffer.from('last line')) },
        { type: 'status', payload: { state: 'disconnected', text: 'Disconnected' } },
        { type: 'output', payload: formatTerminalNotice('Connection disconnected') }
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores late session messages after the webview panel is disposed', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
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

    const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
    await flushPromises();
    const oldSessionEvents = sessionEvents[0];

    await terminal.reconnect();
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);

    oldSessionEvents.status('Disconnected');

    expect(registry.getActive()?.connected).toBe(true);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'status',
      payload: { state: 'disconnected', text: 'Disconnected' }
    });
  });

  it('updates server configuration and re-publishes context across active panels', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    const initial = server('server-to-update');
    TerminalPanel.open(extensionContext(), initial, configManager(), hostKeyVerifier, registry);
    await flushPromises();

    expect(registry.getActive()?.server.label).toBe('server-to-update');

    const updated = {
      ...initial,
      label: 'New Label',
      agentCommandTrust: 'full' as const
    };

    TerminalPanel.updateServer(updated);

    expect(registry.getActive()?.server.label).toBe('New Label');
    expect(registry.getActive()?.server.agentCommandTrust).toBe('full');
  });
});

describe('terminal session status bridge', () => {
  it('passes structured statuses through untouched', () => {
    expect(normalizeSessionStatus({ state: 'connected', text: '已连接' })).toEqual({
      state: 'connected',
      text: '已连接'
    });
  });

  it('maps known string statuses onto structured states', () => {
    expect(normalizeSessionStatus('Connected')).toEqual({ state: 'connected', text: 'Connected' });
    expect(normalizeSessionStatus('Disconnected')).toEqual({ state: 'disconnected', text: 'Disconnected' });
    expect(normalizeSessionStatus('Connecting to host:22...')).toEqual({
      state: 'connecting',
      text: 'Connecting to host:22...'
    });
  });

  it('maps the localized 已断开连接 text as disconnected instead of connecting', () => {
    expect(normalizeSessionStatus('已断开连接')).toEqual({ state: 'disconnected', text: '已断开连接' });
    expect(normalizeSessionStatus('Disconnected after 30 minute(s) of inactivity.').state).toBe('disconnected');
  });
});

describe('terminal host verification errors', () => {
  it('recognizes the ssh2 host verification failure', () => {
    expect(isHostVerificationError(new Error('Host denied (verification failed)'))).toBe(true);
    expect(isHostVerificationError(new Error('Host fingerprint verification failed'))).toBe(true);
  });

  it('does not flag unrelated connection failures', () => {
    expect(isHostVerificationError(new Error('connect ECONNREFUSED'))).toBe(false);
    expect(isHostVerificationError(new Error('Authentication failure'))).toBe(false);
  });
});

describe('terminal flow control', () => {
  it('pauses above the high-water mark and resumes below the low-water mark', () => {
    const session = { pauseOutput: vi.fn(), resumeOutput: vi.fn() };
    const flow = new TerminalFlowController(session, {
      pauseAboveBytes: 100,
      resumeBelowBytes: 40,
      resumeTimeoutMs: 60_000
    });

    flow.onEmitted(90);
    expect(session.pauseOutput).not.toHaveBeenCalled();

    flow.onEmitted(20);
    expect(session.pauseOutput).toHaveBeenCalledTimes(1);
    expect(flow.isPaused()).toBe(true);

    flow.onAcknowledged(60);
    expect(session.resumeOutput).not.toHaveBeenCalled();

    flow.onAcknowledged(20);
    expect(session.resumeOutput).toHaveBeenCalledTimes(1);
    expect(flow.isPaused()).toBe(false);
    flow.dispose();
  });

  it('force-resumes after the timeout so a reloaded webview cannot leave the shell paused', () => {
    try {
      vi.useFakeTimers();
      const session = { pauseOutput: vi.fn(), resumeOutput: vi.fn() };
      const flow = new TerminalFlowController(session, {
        pauseAboveBytes: 10,
        resumeBelowBytes: 5,
        resumeTimeoutMs: 1000
      });

      flow.onEmitted(11);
      expect(flow.isPaused()).toBe(true);

      vi.advanceTimersByTime(1000);

      expect(session.resumeOutput).toHaveBeenCalledTimes(1);
      expect(flow.isPaused()).toBe(false);
      expect(flow.getInflightBytes()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('extends the timeout while acks are still trickling in above the low-water mark', () => {
    try {
      vi.useFakeTimers();
      const session = { pauseOutput: vi.fn(), resumeOutput: vi.fn() };
      const flow = new TerminalFlowController(session, {
        pauseAboveBytes: 10,
        resumeBelowBytes: 2,
        resumeTimeoutMs: 1000
      });

      flow.onEmitted(12);
      vi.advanceTimersByTime(900);
      flow.onAcknowledged(1);
      vi.advanceTimersByTime(900);

      expect(session.resumeOutput).not.toHaveBeenCalled();
      expect(flow.isPaused()).toBe(true);

      vi.advanceTimersByTime(100);
      expect(session.resumeOutput).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resumes a paused session on dispose so a closed panel never leaves the stream stuck', () => {
    const session = { pauseOutput: vi.fn(), resumeOutput: vi.fn() };
    const flow = new TerminalFlowController(session, {
      pauseAboveBytes: 10,
      resumeBelowBytes: 5,
      resumeTimeoutMs: 60_000
    });

    flow.onEmitted(11);
    flow.dispose();

    expect(session.resumeOutput).toHaveBeenCalledTimes(1);
  });

  it('pauses the SSH stream when the webview stops acking and resumes after acks', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
    await flushPromises();
    const events = sessionEvents.at(-1)!;

    const chunk = Buffer.alloc(TERMINAL_OUTPUT_FLUSH_BYTES, 0x61);
    const chunksToPause = Math.floor(TERMINAL_FLOW_PAUSE_BYTES / TERMINAL_OUTPUT_FLUSH_BYTES) + 1;
    for (let index = 0; index < chunksToPause; index += 1) {
      events.output(chunk);
    }

    expect(pauseOutput).toHaveBeenCalledTimes(1);
    expect(resumeOutput).not.toHaveBeenCalled();

    for (let index = 0; index < chunksToPause - 1; index += 1) {
      panelHost.fireMessage({ type: 'ack', bytes: TERMINAL_OUTPUT_FLUSH_BYTES });
    }

    expect(resumeOutput).toHaveBeenCalledTimes(1);
  });
});

describe('terminal reconnect', () => {
  it('reconnects when the webview posts a reconnect message', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
    await flushPromises();
    const connectCalls = connect.mock.calls.length;

    panelHost.fireMessage({ type: 'reconnect' });
    await flushPromises();

    expect(disposeSession).toHaveBeenCalled();
    expect(connect.mock.calls.length).toBe(connectCalls + 1);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'status',
      payload: { state: 'connecting', text: 'Reconnecting...' }
    });
  });

  it('auto-reconnects after an unexpected disconnect and recovers on success', async () => {
    try {
      vi.useFakeTimers();
      const registry = new TerminalContextRegistry();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier, registry);
      await flushPromises();
      expect(registry.getActive()?.connected).toBe(true);
      const connectCalls = connect.mock.calls.length;

      sessionEvents.at(-1)!.status('Disconnected');

      expect(noticeMessages(panelHost.panel).some((notice) => notice.includes('attempt 1 of 3'))).toBe(true);
      expect(registry.getActive()?.connected).toBe(false);

      vi.advanceTimersByTime(TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS);
      await flushPromises();

      expect(connect.mock.calls.length).toBe(connectCalls + 1);
      expect(registry.getActive()?.connected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-reconnect after a user-initiated disconnect', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      const terminal = TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      const connectCalls = connect.mock.calls.length;

      terminal.disconnect();
      sessionEvents.at(-1)!.status('Disconnected');
      vi.advanceTimersByTime(60_000);
      await flushPromises();

      expect(connect.mock.calls.length).toBe(connectCalls);
      expect(noticeMessages(panelHost.panel).some((notice) => notice.includes('Reconnecting in'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries with exponential backoff and gives up after the maximum attempts', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      const connectCalls = connect.mock.calls.length;
      connect.mockRejectedValue(new Error('connect ECONNREFUSED'));

      sessionEvents.at(-1)!.status('Disconnected');

      for (let attempt = 1; attempt <= TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS; attempt += 1) {
        expect(
          noticeMessages(panelHost.panel).some((notice) => notice.includes(`attempt ${attempt} of 3`))
        ).toBe(true);
        vi.advanceTimersByTime(TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
        await flushPromises();
      }

      expect(connect.mock.calls.length).toBe(connectCalls + TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS);
      expect(
        noticeMessages(panelHost.panel).some((notice) => notice.includes('Automatic reconnect stopped after 3'))
      ).toBe(true);

      vi.advanceTimersByTime(600_000);
      await flushPromises();
      expect(connect.mock.calls.length).toBe(connectCalls + TERMINAL_AUTO_RECONNECT_MAX_ATTEMPTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops retrying immediately when host key verification fails', async () => {
    try {
      vi.useFakeTimers();
      const panelHost = createPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

      TerminalPanel.open(extensionContext(), server(), configManager(), hostKeyVerifier);
      await flushPromises();
      const connectCalls = connect.mock.calls.length;
      connect.mockRejectedValue(new Error('Host denied (verification failed)'));

      sessionEvents.at(-1)!.status('Disconnected');
      vi.advanceTimersByTime(TERMINAL_AUTO_RECONNECT_BASE_DELAY_MS);
      await flushPromises();

      expect(connect.mock.calls.length).toBe(connectCalls + 1);
      expect(
        noticeMessages(panelHost.panel).some((notice) => notice.includes('host key verification failed'))
      ).toBe(true);

      vi.advanceTimersByTime(600_000);
      await flushPromises();
      expect(connect.mock.calls.length).toBe(connectCalls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('terminal session log', () => {
  it('names log files after the sanitized server label and id', () => {
    expect(resolveSessionLogFileName({ label: 'My Server #1', id: 'abc' })).toBe('My_Server_1-abc.log');
    expect(resolveSessionLogFileName({ label: '///', id: 'abc' })).toBe('session-abc.log');
  });

  it('appends output chunks to one stream and closes it on dispose', () => {
    const written: Array<{ path: string; data: string }> = [];
    let ended = false;
    const io = {
      mkdir: vi.fn(),
      createStream: vi.fn((path: string) => ({
        write: (chunk: Uint8Array) => written.push({ path, data: Buffer.from(chunk).toString() }),
        end: () => {
          ended = true;
        }
      }))
    };

    const writer = new SessionLogWriter('/logs', { label: 'db server', id: 'srv-1' }, io);
    writer.append(Buffer.from('hello '));
    writer.append(Buffer.from('world'));
    writer.dispose();

    expect(io.mkdir).toHaveBeenCalledWith('/logs');
    expect(io.createStream).toHaveBeenCalledTimes(1);
    expect(written[0].path).toBe(join('/logs', 'db_server-srv-1.log'));
    expect(written.map((entry) => entry.data).join('')).toBe('hello world');
    expect(ended).toBe(true);
  });

  it('disables itself after the first I/O failure instead of breaking the terminal', () => {
    const io = {
      mkdir: vi.fn(() => {
        throw new Error('EACCES');
      }),
      createStream: vi.fn()
    };

    const writer = new SessionLogWriter('/logs', { label: 'a', id: 'b' }, io);
    writer.append(Buffer.from('one'));
    writer.append(Buffer.from('two'));

    expect(io.mkdir).toHaveBeenCalledTimes(1);
    expect(io.createStream).not.toHaveBeenCalled();
  });

  it('writes session output to the configured session log directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'at-terminal-log-'));
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
      get: <T>(key: string, defaultValue: T): T =>
        key === 'sessionLogDirectory' ? (directory as unknown as T) : defaultValue
    } as never);
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), server('logged-server'), configManager(), hostKeyVerifier);
    await flushPromises();
    sessionEvents.at(-1)!.output(Buffer.from('logged output'));
    panelHost.fireDispose();

    const logPath = join(directory, 'logged-server-logged-server.log');
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (!existsSync(logPath) || readFileSync(logPath, 'utf8') !== 'logged output')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(readFileSync(logPath, 'utf8')).toBe('logged output');
  });
});
