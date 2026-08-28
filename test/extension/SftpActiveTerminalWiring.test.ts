import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'vscode';
import type { ServerConfig } from '../../src/config/schema';
import {
  createRegistryBackedSftpTreeSource,
  refreshSftpFilesView,
  registerSftpContextWiring
} from '../../src/extension';
import { SftpManager, type SftpSessionLike } from '../../src/sftp/SftpManager';
import { TerminalContextRegistry, type TerminalContext } from '../../src/terminal/TerminalContext';
import { SftpPlaceholderTreeItem } from '../../src/tree/SftpTreeItems';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';

const PLACEHOLDER = 'No active SSH terminal';

function server(id: string): ServerConfig {
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

function context(connected: boolean, terminalId = 'terminal-a', serverId = 'srv'): TerminalContext {
  return { terminalId, connected, write: vi.fn(), server: server(serverId) };
}

function sessionStub(overrides: Partial<SftpSessionLike> = {}): SftpSessionLike {
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
    dispose: vi.fn(),
    ...overrides
  };
}

/** The exact objects `activate()` wires together, driven without a real webview. */
function harness(createSession: () => SftpSessionLike = () => sessionStub()) {
  const terminalContext = new TerminalContextRegistry();
  const sftpManager = new SftpManager({ createSession });
  const sftpTreeProvider = new SftpTreeProvider({
    getState: () => sftpManager.getState(),
    listDirectory: (path) => sftpManager.listDirectory(path)
  });
  const refreshSftpTree = vi.fn(() => sftpTreeProvider.refresh());
  const onTerminalsChanged = vi.fn();
  const onTerminalRemoved = vi.fn();
  registerSftpContextWiring({
    terminalContext,
    sftpManager,
    refreshSftpTree,
    onTerminalsChanged,
    onTerminalRemoved
  });
  return { terminalContext, sftpManager, sftpTreeProvider, refreshSftpTree, onTerminalsChanged, onTerminalRemoved };
}

describe('SFTP view wiring for the active terminal', () => {
  it('shows the placeholder while the terminal is still connecting', async () => {
    const { terminalContext, sftpManager, sftpTreeProvider } = harness();

    // TerminalPanel.open publishes the context before connect() resolves.
    terminalContext.setActive(context(false));

    expect(sftpManager.getState()).toEqual({ kind: 'none' });
    const children = await sftpTreeProvider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0].label).toBe(PLACEHOLDER);
  });

  it('replaces the placeholder once connect() republishes the active context', async () => {
    const { terminalContext, sftpManager, sftpTreeProvider, refreshSftpTree } = harness();

    // The publishContext sequence of TerminalPanel.open + onDidChangeViewState + connect():
    terminalContext.setActive(context(false));
    terminalContext.setActive(context(false)); // view-state republish, short-circuits in setActive
    terminalContext.setActive(context(true)); // connect() success
    terminalContext.setActive(context(true)); // later view-state republish

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    const children = await sftpTreeProvider.getChildren();
    const labels = children.map((child) => child.label);
    expect(labels).not.toContain(PLACEHOLDER);
    expect(labels).toEqual(['..', 'app', 'readme.txt']);
    // One refresh for the newly active terminal, one for the connect flip; the
    // unchanged republishes must not repaint the tree.
    expect(refreshSftpTree).toHaveBeenCalledTimes(2);
  });

  it('cannot miss a connected flip that fires only onDidChangeContext', async () => {
    // TerminalContext.setActive skips onDidChangeActiveContext when it considers the
    // republished context unchanged. Simulate a registry path where a connected flip of the
    // active terminal reaches subscribers only through onDidChangeContext: SFTP must still
    // pick it up.
    const activeEmitter = new EventEmitter<TerminalContext | undefined>();
    const contextEmitter = new EventEmitter<TerminalContext>();
    const removedEmitter = new EventEmitter<string>();
    const sftpManager = new SftpManager({ createSession: () => sessionStub() });
    const sftpTreeProvider = new SftpTreeProvider({
      getState: () => sftpManager.getState(),
      listDirectory: (path) => sftpManager.listDirectory(path)
    });
    const refreshSftpTree = vi.fn(() => sftpTreeProvider.refresh());
    registerSftpContextWiring({
      terminalContext: {
        onDidChangeActiveContext: activeEmitter.event,
        onDidChangeContext: contextEmitter.event,
        onDidRemoveContext: removedEmitter.event
      },
      sftpManager,
      refreshSftpTree,
      onTerminalsChanged: vi.fn()
    });

    activeEmitter.fire(context(false));
    expect(sftpManager.getState()).toEqual({ kind: 'none' });

    contextEmitter.fire(context(true));

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    expect(refreshSftpTree).toHaveBeenCalledTimes(2);
    const children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
  });

  it('renders an SFTP error row instead of the stale placeholder when the SFTP channel fails', async () => {
    // The terminal holds its own SSH connection; SftpSession opens a second one that can
    // fail on its own (e.g. keyboard-interactive auth has no prompt in the SFTP path).
    // getChildren must not reject, or VS Code keeps the previous children — the placeholder.
    const session = sessionStub({
      connect: vi.fn(async () => {
        throw new Error(
          'The server requested keyboard-interactive authentication, but no interactive prompt is available in this context.'
        );
      })
    });
    const { terminalContext, sftpManager, sftpTreeProvider } = harness(() => session);

    terminalContext.setActive(context(false));
    terminalContext.setActive(context(true));

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    const children = await sftpTreeProvider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toContain('SFTP error:');
    expect(children[0].label).toContain('keyboard-interactive');
    expect(children[0].label).not.toBe(PLACEHOLDER);
  });

  it('keeps a disconnected snapshot when the active terminal drops', async () => {
    const { terminalContext, sftpManager, sftpTreeProvider } = harness();
    terminalContext.setActive(context(true));
    await sftpManager.ensureRoot();
    await sftpTreeProvider.getChildren(); // lists the resolved root, capturing the snapshot

    terminalContext.setActive(context(false)); // connection lost, publishContext republishes

    expect(sftpManager.getState()).toMatchObject({ kind: 'disconnected', rootPath: '/home/deploy' });
    const children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.contextValue)).toEqual([
      'sftpDisconnectedDirectory',
      'sftpDisconnectedFile'
    ]);
  });

  it('heals through the Refresh command when the registry has a connected terminal SFTP never saw', async () => {
    // The user report: terminal connected (registry/MCP see it), SFTP still says
    // 「无活动的 SSH 终端」, and Refresh changes nothing. Simulate the missed events by
    // never wiring the listeners: SftpManager.getState() is stuck on { kind: 'none' }.
    const terminalContext = new TerminalContextRegistry();
    const sftpManager = new SftpManager({ createSession: () => sessionStub() });
    const sftpTreeProvider = new SftpTreeProvider({
      getState: () => sftpManager.getState(),
      listDirectory: (path) => sftpManager.listDirectory(path)
    });
    terminalContext.setActive(context(true));
    expect(terminalContext.getSnapshot().connectedTerminals).toHaveLength(1);
    expect(sftpManager.getState()).toEqual({ kind: 'none' });

    // The production sshManager.sftp.refresh handler.
    refreshSftpFilesView({
      terminalContext,
      sftpManager,
      refreshSftpTree: () => sftpTreeProvider.refresh()
    });

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    const children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
    expect(children.map((child) => child.label)).toEqual(['..', 'app', 'readme.txt']);
  });

  it('heals on every tree read: getChildren re-checks the registry before rendering the placeholder', async () => {
    const terminalContext = new TerminalContextRegistry();
    const sftpManager = new SftpManager({ createSession: () => sessionStub() });
    // The exact source activate() hands to SftpTreeProvider.
    const sftpTreeProvider = new SftpTreeProvider(
      createRegistryBackedSftpTreeSource(terminalContext, sftpManager)
    );
    terminalContext.setActive(context(true));
    expect(sftpManager.getState()).toEqual({ kind: 'none' });

    const children = await sftpTreeProvider.getChildren();

    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
    // Listing the root resolves rootPath, so only the kind matters here.
    expect(sftpManager.getState()).toMatchObject({ kind: 'active' });
  });

  it('adopts a connected context that only ever arrives through syncTerminalContext', async () => {
    // setTerminalContext is never called: the connected terminal reaches SFTP only via
    // onDidChangeContext → syncTerminalContext. Before the fix syncTerminalContext left
    // activeTerminalId unset, so the view stayed on the placeholder forever.
    const activeEmitter = new EventEmitter<TerminalContext | undefined>();
    const contextEmitter = new EventEmitter<TerminalContext>();
    const removedEmitter = new EventEmitter<string>();
    const sftpManager = new SftpManager({ createSession: () => sessionStub() });
    const sftpTreeProvider = new SftpTreeProvider({
      getState: () => sftpManager.getState(),
      listDirectory: (path) => sftpManager.listDirectory(path)
    });
    const refreshSftpTree = vi.fn(() => sftpTreeProvider.refresh());
    registerSftpContextWiring({
      terminalContext: {
        onDidChangeActiveContext: activeEmitter.event,
        onDidChangeContext: contextEmitter.event,
        onDidRemoveContext: removedEmitter.event
      },
      sftpManager,
      refreshSftpTree,
      onTerminalsChanged: vi.fn()
    });

    contextEmitter.fire(context(true));

    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
    expect(refreshSftpTree).toHaveBeenCalledTimes(1);
    const children = await sftpTreeProvider.getChildren();
    expect(children.map((child) => child.label)).not.toContain(PLACEHOLDER);
  });

  it('does not let a background context update steal the view from an explicitly active terminal', async () => {
    const { terminalContext, sftpManager } = harness();

    terminalContext.setActive(context(true, 'terminal-a', 'srv-a'));
    // Another connected terminal only syncs; the active choice must stand.
    sftpManager.syncTerminalContext(context(true, 'terminal-b', 'srv-b'));

    expect(sftpManager.getActiveServerId()).toBe('srv-a');
    expect(sftpManager.getState()).toEqual({ kind: 'active', rootPath: '.' });
  });

  it('returns to the placeholder when the active terminal panel is disposed', async () => {
    const { terminalContext, sftpManager, sftpTreeProvider, refreshSftpTree, onTerminalRemoved } = harness();
    terminalContext.setActive(context(true));
    refreshSftpTree.mockClear();

    terminalContext.clearIfActive('terminal-a');

    expect(onTerminalRemoved).toHaveBeenCalledWith('terminal-a');
    expect(sftpManager.getState()).toEqual({ kind: 'none' });
    // The registry clears its active context only after the removal event, so the repaint
    // must come from the removal handler itself.
    expect(refreshSftpTree).toHaveBeenCalledTimes(1);
    const children = await sftpTreeProvider.getChildren();
    expect(children[0].label).toBe(PLACEHOLDER);
  });
});
