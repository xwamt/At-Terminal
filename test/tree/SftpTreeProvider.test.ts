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

    expect(children[0]).toBeInstanceOf(SftpDirectoryTreeItem);
    expect(children[1]).toBeInstanceOf(SftpFileTreeItem);
    expect(children.map((child) => child.contextValue)).toEqual(['sftpDirectory', 'sftpFile']);
  });

  it('marks snapshot entries disconnected', async () => {
    const provider = new SftpTreeProvider({
      getState: () => ({ kind: 'disconnected', rootPath: '/home/deploy', entries })
    });

    const children = await provider.getChildren();

    expect(children.map((child) => child.contextValue)).toEqual(['sftpDisconnectedDirectory', 'sftpDisconnectedFile']);
  });
});
