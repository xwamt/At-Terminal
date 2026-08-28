import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { ServerConfig } from '../../src/config/schema';
import {
  createRegistryBackedSftpTreeSource,
  deactivate,
  refreshSftpFilesView,
  registerSftpContextWiring
} from '../../src/extension';
import { SftpManager, type SftpSessionLike } from '../../src/sftp/SftpManager';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';
import { TerminalPanel, type SessionStatusEvent } from '../../src/webview/TerminalPanel';

const PLACEHOLDER = 'No active SSH terminal';

const connect = vi.fn<() => Promise<void>>();
const sessionEvents: Array<{ output(data: Buffer): void; status(message: SessionStatusEvent): void }> = [];

vi.mock('../../src/ssh/SshSession', () => ({
  SshSession: vi.fn().mockImplementation((_server, _configManager, events) => {
    sessionEvents.push(events);
    return {
      connect,
      dispose: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      pauseOutput: vi.fn(),
      resumeOutput: vi.fn()
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

function sftpSessionStub(): SftpSessionLike {
  return {
    connect: vi.fn(),
    realpath: vi.fn(async () => '/home/deploy'),
    listDirectory: vi.fn(async () => [
      { name: 'app', path: '/home/deploy/app', type: 'directory' as const },
      { name: 'readme.txt', path: '/home/deploy/readme.txt', type: 'file' as const, size: 12 }
    ]),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    deleteFile: vi.fn(),
    deleteDirectory: vi.fn(),
    countDeletableEntries: vi.fn(async () => 0),
    uploadFile: vi.fn(),
    downloadFile: vi.fn(),
    uploadDirectory: vi.fn(),
    downloadDirectory: vi.fn(),
    createFile: vi.fn(),
    stat: vi.fn(async () => ({ size: 0, modifiedAt: 0 })),
    dispose: vi.fn()
  };
}

function createPanel(): vscode.WebviewPanel {
  return {
    active: true,
    webview: {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
      postMessage: vi.fn()
    },
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as vscode.WebviewPanel;
}

function extensionContext(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file('extension-root') } as vscode.ExtensionContext;
}

const hostKeyVerifier = { verify: async () => true };

/** The exact SFTP objects and wiring activate() creates, around a real TerminalPanel. */
function harness() {
  const terminalContext = new TerminalContextRegistry();
  const sftpManager = new SftpManager({ createSession: () => sftpSessionStub() });
  const sftpTreeProvider = new SftpTreeProvider(
    createRegistryBackedSftpTreeSource(terminalContext, sftpManager)
  );
  registerSftpContextWiring({
    terminalContext,
    sftpManager,
    refreshSftpTree: () => sftpTreeProvider.refresh(),
    onTerminalsChanged: vi.fn()
  });
  const runRefreshCommand = () =>
    refreshSftpFilesView({
      terminalContext,
      sftpManager,
      refreshSftpTree: () => sftpTreeProvider.refresh()
    });
  return { terminalContext, sftpManager, sftpTreeProvider, runRefreshCommand };
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
  connect.mockReset();
  connect.mockResolvedValue(undefined);
  sessionEvents.length = 0;
  vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(createPanel());
});

describe('SFTP view driven by a real TerminalPanel', () => {
  it('leaves the placeholder after TerminalPanel.open connects, and stays off it after Refresh', async () => {
    const { terminalContext, sftpManager, sftpTreeProvider, runRefreshCommand } = harness();

    TerminalPanel.open(extensionContext(), server(), {} as never, hostKeyVerifier, terminalContext);

    await flushPromises();

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    let children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
    expect(children.map((child) => child.label)).toEqual(['..', 'app', 'readme.txt']);

    runRefreshCommand();
    children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
  });

  it('shows files (not the placeholder) once the session reports connected, even while connect() is still pending', async () => {
    const { terminalContext, sftpTreeProvider, runRefreshCommand } = harness();
    const pendingConnect = deferred<void>();
    connect.mockReturnValueOnce(pendingConnect.promise);

    TerminalPanel.open(extensionContext(), server(), {} as never, hostKeyVerifier, terminalContext);
    // The connect() tail has not run: only the session status reports connected — which is
    // exactly what flips the webview status bar to "Connected" for the user.
    sessionEvents.at(-1)!.status({ state: 'connected', text: 'Connected' });

    expect(terminalContext.getSnapshot().connectedTerminals).toHaveLength(1);
    runRefreshCommand();
    const children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);

    pendingConnect.resolve();
    await flushPromises();
    expect((await sftpTreeProvider.getChildren()).map((child) => child.label)).not.toContain(PLACEHOLDER);
  });
});
