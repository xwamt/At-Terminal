import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { GroupTreeItem } from '../../src/tree/TreeItems';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  bridgeConstructed: vi.fn(),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true })),
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' }))
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: class {
    constructor() {
      mocks.bridgeConstructed();
    }
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

function storedServer(id: string) {
  return {
    id,
    label: `Server ${id}`,
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

function extensionContext(servers: unknown[] = []): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.3.4'),
    globalStorageUri: vscode.Uri.file('C:/tmp/at-terminal-storage'),
    globalState: {
      get: vi.fn((key: string, defaultValue: unknown) =>
        key === 'sshManager.servers' && servers.length > 0 ? servers : defaultValue
      ),
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

describe('servers tree view registration during activate', () => {
  let createdTreeViews: Array<{ viewId: string; options: Record<string, unknown>; reveal: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>;
  let createTreeView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    deactivate();
    createdTreeViews = [];
    mocks.bridgeConstructed.mockClear();
    mocks.syncPackagedHub.mockClear();
    mocks.syncPackagedHub.mockImplementation(async () => ({ updated: false, activeVersion: '0.1.0' }));
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(() => ({ dispose: vi.fn() }));
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    createTreeView = vi.fn((viewId: string, options: Record<string, unknown>) => {
      const view = { viewId, options, reveal: vi.fn(async () => undefined), dispose: vi.fn() };
      createdTreeViews.push(view);
      return view;
    });
    vi.spyOn(vscode.window, 'createTreeView').mockImplementation(createTreeView as never);
  });

  afterEach(() => {
    deactivate();
    vi.restoreAllMocks();
  });

  it('registers both tree views before any MCP wiring runs', () => {
    activate(extensionContext());

    expect(createdTreeViews.map((view) => view.viewId)).toEqual([
      'sshManager.servers',
      'sshManager.sftpFiles'
    ]);
    expect(createdTreeViews[0].options).toMatchObject({ showCollapseAll: true });
    expect(createdTreeViews[0].options.treeDataProvider).toBeDefined();
    expect(createdTreeViews[1].options).toMatchObject({ showCollapseAll: true });
    expect(createdTreeViews[1].options.dragAndDropController).toBeDefined();
    // The views must exist before MCP construction so a slow (or failing) MCP
    // startup can never leave the viewsWelcome placeholder on screen.
    expect(Math.max(...createTreeView.mock.invocationCallOrder)).toBeLessThan(
      Math.min(
        mocks.bridgeConstructed.mock.invocationCallOrder[0],
        mocks.syncPackagedHub.mock.invocationCallOrder[0]
      )
    );
  });

  it('pushes the same tree view instances into subscriptions for disposal', () => {
    const context = extensionContext();
    activate(context);

    for (const view of createdTreeViews) {
      expect(context.subscriptions).toContain(view);
    }
  });

  it('still registers both tree views when MCP setup throws during activate', () => {
    mocks.syncPackagedHub.mockImplementation(() => {
      throw new Error('hub sync exploded');
    });

    expect(() => activate(extensionContext())).toThrow('hub sync exploded');

    expect(createdTreeViews.map((view) => view.viewId)).toEqual([
      'sshManager.servers',
      'sshManager.sftpFiles'
    ]);
  });

  it('reveals a lone group expanded after activation so stored servers are visible', async () => {
    activate(extensionContext([storedServer('a'), storedServer('b')]));

    await vi.waitFor(() => {
      expect(createdTreeViews[0].reveal).toHaveBeenCalledTimes(1);
    });
    const [element, options] = createdTreeViews[0].reveal.mock.calls[0];
    expect(element).toBeInstanceOf(GroupTreeItem);
    expect((element as GroupTreeItem).groupName).toBe('Default');
    expect(options).toMatchObject({ expand: true });
  });

  it('does not reveal anything when no servers are stored', async () => {
    activate(extensionContext());

    // Let the end-of-activate listServers().then(...) chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(createdTreeViews[0].reveal).not.toHaveBeenCalled();
  });
});
