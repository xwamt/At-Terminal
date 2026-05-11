import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  ensureKiroMcpConfig: vi.fn(async () => undefined),
  installContinueMcpConfig: vi.fn(async () => 'continue-config'),
  installKiroMcpConfig: vi.fn(async () => 'kiro-config')
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: class {
    dispose = mocks.bridgeDispose;
    start = mocks.bridgeStart;
  }
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureKiroMcpConfig: mocks.ensureKiroMcpConfig,
  installContinueMcpConfig: mocks.installContinueMcpConfig,
  installKiroMcpConfig: mocks.installKiroMcpConfig
}));

import { activate, deactivate } from '../../src/extension';

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10'),
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

describe('sshManager.installMcpConfig command', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    deactivate();
    registeredCommands.clear();
    mocks.bridgeDispose.mockClear();
    mocks.bridgeStart.mockClear();
    mocks.ensureKiroMcpConfig.mockClear();
    mocks.installContinueMcpConfig.mockClear();
    mocks.installKiroMcpConfig.mockClear();
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

  it('installs Kiro MCP config even when no workspace is open', async () => {
    activate(extensionContext());

    await registeredCommands.get('sshManager.installMcpConfig')?.();

    expect(mocks.installKiroMcpConfig).toHaveBeenCalledWith({
      mcpServerPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });
    expect(mocks.installContinueMcpConfig).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(
      'Open a workspace folder before installing AT Terminal MCP config.'
    );
  });

  it('ensures Kiro MCP config points at the current bundled server on activation', () => {
    activate(extensionContext());

    expect(mocks.ensureKiroMcpConfig).toHaveBeenCalledWith({
      mcpServerPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });
  });
});
