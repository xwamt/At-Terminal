import { describe, expect, it } from 'vitest';
import type { SftpEntry } from '../../src/sftp/SftpTypes';
import { SftpTreeProvider } from '../../src/tree/SftpTreeProvider';
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
});
