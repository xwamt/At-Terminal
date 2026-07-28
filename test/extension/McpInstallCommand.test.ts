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

import { activate, deactivate } from '../../src/extension';

function extensionContext(extensionRoot = 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10'): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(extensionRoot),
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

describe('sshManager MCP config commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    deactivate();
    registeredCommands.clear();
    mocks.bridgeDispose.mockClear();
    mocks.bridgeStart.mockClear();
    mocks.ensureAtSeriesConfigForCurrentIde.mockClear();
    mocks.uninstallAtSeriesConfigForCurrentIde.mockClear();
    mocks.syncPackagedHub.mockClear();
    delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(name, handler);
      return { dispose: vi.fn() };
    });
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'withProgress').mockResolvedValue(undefined);
  });

  afterEach(() => {
    deactivate();
    vi.restoreAllMocks();
  });

  it('ensures AT Series MCP config on activation', async () => {
    activate(extensionContext());

    expect(mocks.syncPackagedHub).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
        appName: vscode.env.appName,
        appRoot: vscode.env.appRoot,
        uriScheme: vscode.env.uriScheme,
        extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10',
        workspaceFolder: undefined
      });
    });
  });

  it('install command calls ensure for current IDE', async () => {
    activate(extensionContext());

    await registeredCommands.get('sshManager.installMcpConfig')?.();

    expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10',
      workspaceFolder: undefined
    });
  });

  it('uninstall command removes AT Series MCP config', async () => {
    activate(extensionContext('C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10'));

    await registeredCommands.get('sshManager.uninstallAtSeriesMcpConfig')?.();

    expect(mocks.uninstallAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: 'C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10',
      workspaceFolder: undefined
    });
  });

  it('dispose unpublishes bridge without uninstalling MCP config', async () => {
    const context = extensionContext();
    activate(context);

    mocks.uninstallAtSeriesConfigForCurrentIde.mockClear();
    for (const subscription of [...context.subscriptions].reverse()) {
      await Promise.resolve(subscription.dispose());
    }
    deactivate();

    expect(mocks.bridgeDispose).toHaveBeenCalled();
    expect(mocks.uninstallAtSeriesConfigForCurrentIde).not.toHaveBeenCalled();
  });
});
