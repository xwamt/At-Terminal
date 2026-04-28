import { describe, expect, it } from 'vitest';
import { SftpFileTreeItem } from '../../src/tree/SftpTreeItems';

describe('SftpTreeItems', () => {
  it('formats file sizes with readable units', () => {
    expect(new SftpFileTreeItem({ name: 'small.txt', path: '/small.txt', type: 'file', size: 512 }).description).toBe(
      '512 B'
    );
    expect(new SftpFileTreeItem({ name: 'one-k.txt', path: '/one-k.txt', type: 'file', size: 1024 }).description).toBe(
      '1 KB'
    );
    expect(
      new SftpFileTreeItem({ name: 'one-and-half-k.txt', path: '/one-and-half-k.txt', type: 'file', size: 1536 })
        .description
    ).toBe('1.5 KB');
    expect(
      new SftpFileTreeItem({ name: 'one-m.txt', path: '/one-m.txt', type: 'file', size: 1024 * 1024 }).description
    ).toBe('1 MB');
  });
});
