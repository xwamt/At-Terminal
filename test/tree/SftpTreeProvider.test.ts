import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '../../src/sftp/SftpTypes';
import {
  SftpTreeProvider,
  shouldRefreshOnContextChange,
  type SftpViewDescriptor
} from '../../src/tree/SftpTreeProvider';
import { SftpDirectoryTreeItem, SftpFileTreeItem, SftpPlaceholderTreeItem } from '../../src/tree/SftpTreeItems';

const entries: SftpEntry[] = [
  { name: 'app', path: '/home/deploy/app', type: 'directory' },
  { name: 'readme.txt', path: '/home/deploy/readme.txt', type: 'file', size: 12 }
];

describe('SftpTreeProvider', () => {
  it('shows a placeholder with no active terminal', async () => {
    const provider = new SftpTreeProvider({ getState: () => ({ kind: 'none' }) });
    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpPlaceholderTreeItem);
    expect(children[0].label).toBe('No active SSH terminal');
  });

  it('renders active root entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/deploy' }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[1]).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(children[2]).toBeInstanceOf(SftpFileTreeItem);
    expect(children.slice(1).map((child) => child.contextValue)).toEqual(['sftpDirectory', 'sftpFile']);
  });

  it('renders a parent directory entry above active root entries', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/deploy' }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[0].label).toBe('..');
    expect(children[0].contextValue).toBe('sftpParentDirectory');
    expect(children[0].command).toEqual({
      command: 'sshManager.sftp.goUp',
      title: 'Go Up'
    });
    expect(children.slice(1).map((child) => child.contextValue)).toEqual(['sftpDirectory', 'sftpFile']);
  });

  it('does not render a parent directory entry at the remote filesystem root', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/' }),
      listDirectory: async () => entries
    });

    const children = await provider.getChildren();

    expect(children[0]).toBeInstanceOf(SftpDirectoryTreeItem);
  });

  it('marks snapshot entries disconnected', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/deploy', entries })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['sftpDisconnectedDirectory', 'sftpDisconnectedFile']);
  });

  it('renders a symlink to a directory as an expandable directory item', async () => {
    const listedPaths: string[] = [];
    const symlinkEntries: SftpEntry[] = [
      { name: 'dirlink', path: '/home/deploy/dirlink', type: 'symlink', targetType: 'directory' },
      { name: 'filelink', path: '/home/deploy/filelink', type: 'symlink', targetType: 'file' },
      { name: 'broken', path: '/home/deploy/broken', type: 'symlink' }
    ];
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'active', rootPath: '/home/deploy' }),
      listDirectory: async (path) => {
        listedPaths.push(path);
        return path === '/home/deploy' ? symlinkEntries : [];
      }
    });

    const children = await provider.getChildren();
    const dirlink = children.find((child) => child.label === 'dirlink');
    const filelink = children.find((child) => child.label === 'filelink');
    const broken = children.find((child) => child.label === 'broken');

    expect(dirlink).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(dirlink?.contextValue).toBe('sftpDirectory');
    expect(filelink).toBeInstanceOf(SftpFileTreeItem);
    expect(broken).toBeInstanceOf(SftpFileTreeItem);

    await provider.getChildren(dirlink as SftpDirectoryTreeItem);
    expect(listedPaths).toContain('/home/deploy/dirlink');
  });
});

describe('shouldRefreshOnContextChange', () => {
  const base: SftpViewDescriptor = { terminalId: 'terminal-a', rootPath: '/home/deploy', connected: true };

  it('skips the refresh when switching back to the same terminal and root', () => {
    expect(shouldRefreshOnContextChange(base, { ...base })).toBe(false);
  });

  it('refreshes when the terminal changes', () => {
    expect(shouldRefreshOnContextChange(base, { ...base, terminalId: 'terminal-b' })).toBe(true);
  });

  it('refreshes when the root path changes', () => {
    expect(shouldRefreshOnContextChange(base, { ...base, rootPath: '/var/log' })).toBe(true);
  });

  it('refreshes when the connection state changes', () => {
    expect(shouldRefreshOnContextChange(base, { ...base, connected: false })).toBe(true);
  });

  it('refreshes when either side has no descriptor', () => {
    expect(shouldRefreshOnContextChange(undefined, base)).toBe(true);
    expect(shouldRefreshOnContextChange(base, undefined)).toBe(true);
    expect(shouldRefreshOnContextChange(undefined, undefined)).toBe(true);
  });
});
