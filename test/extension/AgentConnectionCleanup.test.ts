import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true })),
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' }))
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: class {
    dispose = mocks.bridgeDispose;
    start = mocks.bridgeStart;
  }
}));

vi.mock('../../src/mcp/hubSync', () => ({
  syncPackagedHub: mocks.syncPackagedHub
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: mocks.ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde: mocks.uninstallAtSeriesConfigForCurrentIde
}));

import { RemoteCommandExecutor } from '../../src/agent/RemoteCommandExecutor';
import { activate, deactivate, registerSftpContextWiring } from '../../src/extension';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.3.0'),
    globalStorageUri: vscode.Uri.file('C:/tmp/at-terminal-storage'),
    globalState: {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(async () => undefined)
    },
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined)
    },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

describe('agent SSH connection cleanup', () => {
  beforeEach(() => {
    deactivate();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(() => ({ dispose: vi.fn() }));
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  });

  afterEach(() => {
    deactivate();
    vi.restoreAllMocks();
  });


  it('disposes the terminal SFTP session as soon as the terminal reports disconnected', () => {
    const registry = new TerminalContextRegistry();
    const disposeTerminal = vi.fn();
    registerSftpContextWiring({
      terminalContext: registry,
      sftpManager: {
        setTerminalContext: vi.fn(),
        syncTerminalContext: vi.fn(),
        removeTerminalContext: vi.fn(),
        getActiveViewDescriptor: vi.fn(() => undefined)
      },
      refreshSftpTree: vi.fn(),
      onTerminalsChanged: vi.fn(),
      onTerminalRemoved: disposeTerminal
    });
    registry.setActive({
      terminalId: 'terminal-1',
      server: {
        id: 'server-1',
        label: 'server-1',
        host: 'example.com',
        port: 22,
        username: 'deploy',
        authType: 'password',
        keepAliveInterval: 30,
        encoding: 'utf-8',
        createdAt: 1,
        updatedAt: 1
      },
      connected: true,
      write: vi.fn()
    });

    registry.markDisconnected('terminal-1');

    expect(disposeTerminal).toHaveBeenCalledWith('terminal-1');
  });

  it('closes pooled agent SSH connections when the extension deactivates', () => {
    const dispose = vi.spyOn(RemoteCommandExecutor.prototype, 'dispose');
    activate(extensionContext());

    deactivate();

    expect(dispose).toHaveBeenCalled();
  });
});
