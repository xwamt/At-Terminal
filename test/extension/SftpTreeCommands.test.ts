import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { SftpManager } from '../../src/sftp/SftpManager';
import { SftpDirectoryTreeItem, SftpFileTreeItem } from '../../src/tree/SftpTreeItems';

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
    refreshCapabilities = async () => undefined;
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

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.cursor/extensions/local.at-terminal-mcp-0.3.4'),
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

describe('SFTP tree commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    deactivate();
    registeredCommands.clear();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(
      (name: string, handler: (...args: unknown[]) => unknown) => {
        registeredCommands.set(name, handler);
        return { dispose: vi.fn() };
      }
    );
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'createTreeView').mockReturnValue({
      dispose: vi.fn(),
      reveal: vi.fn(async () => undefined)
    } as never);
    activate(extensionContext());
  });

  afterEach(() => {
    deactivate();
    vi.restoreAllMocks();
  });

  it('invalidates the listing cache before an explicit SFTP refresh', () => {
    const invalidate = vi.spyOn(SftpManager.prototype, 'invalidateAllListings');

    registeredCommands.get('sshManager.sftp.refresh')?.();

    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('asks to unlink a directory symlink without counting through the target', async () => {
    const count = vi.spyOn(SftpManager.prototype, 'countDeletableEntries');
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const item = new SftpDirectoryTreeItem({
      name: 'current',
      path: '/srv/current',
      type: 'symlink',
      targetType: 'directory'
    });

    await registeredCommands.get('sshManager.sftp.delete')?.(item);

    expect(count).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith(
      'Delete remote symlink "/srv/current"?',
      { modal: true },
      'Delete'
    );
  });

  it('counts entries before deleting a real directory', async () => {
    vi.spyOn(SftpManager.prototype, 'countDeletableEntries').mockResolvedValue(7);
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const item = new SftpDirectoryTreeItem({
      name: 'logs',
      path: '/var/logs',
      type: 'directory'
    });

    await registeredCommands.get('sshManager.sftp.delete')?.(item);

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Delete remote directory "/var/logs"? 7 entries will be permanently deleted.',
      { modal: true },
      'Delete'
    );
  });

  it('uses the plain delete prompt for a file', async () => {
    const count = vi.spyOn(SftpManager.prototype, 'countDeletableEntries');
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const item = new SftpFileTreeItem({
      name: 'notes.txt',
      path: '/home/deploy/notes.txt',
      type: 'file',
      size: 12
    });

    await registeredCommands.get('sshManager.sftp.delete')?.(item);

    expect(count).not.toHaveBeenCalled();
    expect(showWarningMessage).toHaveBeenCalledWith(
      'Delete remote file "/home/deploy/notes.txt"?',
      { modal: true },
      'Delete'
    );
  });
});
