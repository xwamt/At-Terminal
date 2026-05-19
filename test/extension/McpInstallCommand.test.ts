import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  ensureIdeMcpConfig: vi.fn(async () => undefined),
  ensureKiroMcpConfig: vi.fn(async () => undefined),
  installContinueMcpConfig: vi.fn(async () => 'continue-config'),
  installIdeMcpConfig: vi.fn(async () => 'ide-config'),
  installKiroMcpConfig: vi.fn(async () => 'kiro-config')
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: class {
    dispose = mocks.bridgeDispose;
    start = mocks.bridgeStart;
  }
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureIdeMcpConfig: mocks.ensureIdeMcpConfig,
  ensureKiroMcpConfig: mocks.ensureKiroMcpConfig,
  installContinueMcpConfig: mocks.installContinueMcpConfig,
  installIdeMcpConfig: mocks.installIdeMcpConfig,
  resolveIdeMcpConfigTarget: vi.fn((options: { extensionPath?: string }) => {
    const extensionPath = options.extensionPath ?? '';
    if (extensionPath.includes('/.cursor/') || extensionPath.includes('\\.cursor\\')) {
      return { id: 'cursor', displayName: 'Cursor' };
    }
    if (extensionPath.includes('/.kiro/') || extensionPath.includes('\\.kiro\\')) {
      return { id: 'kiro', displayName: 'Kiro' };
    }
    return undefined;
  }),
  installKiroMcpConfig: mocks.installKiroMcpConfig
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

describe('sshManager.installMcpConfig command', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    deactivate();
    registeredCommands.clear();
    mocks.bridgeDispose.mockClear();
    mocks.bridgeStart.mockClear();
    mocks.ensureIdeMcpConfig.mockClear();
    mocks.ensureKiroMcpConfig.mockClear();
    mocks.installContinueMcpConfig.mockClear();
    mocks.installIdeMcpConfig.mockClear();
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

  it('installs current IDE MCP config even when no workspace is open', async () => {
    activate(extensionContext());

    await registeredCommands.get('sshManager.installMcpConfig')?.();

    expect(mocks.installIdeMcpConfig).toHaveBeenCalledWith({
      target: { id: 'kiro', displayName: 'Kiro' },
      mcpServerPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });
    expect(mocks.installKiroMcpConfig).not.toHaveBeenCalled();
    expect(mocks.installContinueMcpConfig).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalledWith(
      'Open a workspace folder before installing AT Terminal MCP config.'
    );
  });

  it('ensures current IDE MCP config points at the current bundled server on activation', () => {
    activate(extensionContext());

    expect(mocks.ensureIdeMcpConfig).toHaveBeenCalledWith({
      target: { id: 'kiro', displayName: 'Kiro' },
      mcpServerPath: 'C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });
    expect(mocks.ensureKiroMcpConfig).not.toHaveBeenCalled();
  });

  it('uses Cursor MCP config when the extension is installed in Cursor', async () => {
    activate(extensionContext('C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10'));

    expect(mocks.ensureIdeMcpConfig).toHaveBeenCalledWith({
      target: { id: 'cursor', displayName: 'Cursor' },
      mcpServerPath: 'C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });

    await registeredCommands.get('sshManager.installMcpConfig')?.();

    expect(mocks.installIdeMcpConfig).toHaveBeenCalledWith({
      target: { id: 'cursor', displayName: 'Cursor' },
      mcpServerPath: 'C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'
    });
    expect(mocks.ensureKiroMcpConfig).not.toHaveBeenCalled();
    expect(mocks.installKiroMcpConfig).not.toHaveBeenCalled();
  });
});
