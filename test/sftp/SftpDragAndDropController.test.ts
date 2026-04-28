import { describe, expect, it } from 'vitest';
import { collectDraggedUris, localUploadFileName } from '../../src/sftp/SftpDragAndDropController';

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

  it('uses only the base file name when uploading Windows local paths', () => {
    expect(localUploadFileName('C:\\Users\\alan\\Desktop\\docker-compose.yml')).toBe('docker-compose.yml');
  });

  it('uses only the base file name when uploading POSIX local paths', () => {
    expect(localUploadFileName('/home/alan/archive.tar.gz')).toBe('archive.tar.gz');
  });
});
