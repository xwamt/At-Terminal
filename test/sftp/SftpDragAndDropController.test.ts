import { describe, expect, it } from 'vitest';
import { collectDraggedUris } from '../../src/sftp/SftpDragAndDropController';

describe('collectDraggedUris', () => {
  it('reads uri-list payloads', async () => {
    const item = { asString: async () => 'file:///C:/project/a.txt\r\nfile:///C:/project/b.txt' };
    const dataTransfer = new Map([['text/uri-list', item]]);

    expect(await collectDraggedUris(dataTransfer as never)).toEqual(['file:///C:/project/a.txt', 'file:///C:/project/b.txt']);
  });

  it('ignores comments and empty lines', async () => {
    const item = { asString: async () => '# comment\r\n\r\nfile:///C:/project/a.txt' };
    const dataTransfer = new Map([['text/uri-list', item]]);

    expect(await collectDraggedUris(dataTransfer as never)).toEqual(['file:///C:/project/a.txt']);
  });
});
