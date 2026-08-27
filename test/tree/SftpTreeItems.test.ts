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

  it('opens the read-only preview on click, passing itself as the command argument', () => {
    const item = new SftpFileTreeItem({ name: 'app.js', path: '/srv/app.js', type: 'file', size: 10 });

    expect(item.command).toEqual({
      command: 'sshManager.sftp.openPreview',
      title: 'Preview Remote File',
      arguments: [item]
    });
  });

  it('explains in the tooltip that editing uploads back to the server on save', () => {
    const item = new SftpFileTreeItem({ name: 'app.js', path: '/srv/app.js', type: 'file', size: 10 });

    expect(item.tooltip).toContain('/srv/app.js');
    expect(item.tooltip).toContain('uploaded back to the server on save');
  });

  it('keeps disconnected snapshot files inert: no click command, plain path tooltip', () => {
    const item = new SftpFileTreeItem({ name: 'app.js', path: '/srv/app.js', type: 'file', size: 10 }, true);

    expect(item.command).toBeUndefined();
    expect(item.tooltip).toBe('/srv/app.js');
  });
});
