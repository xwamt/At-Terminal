import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  collectDraggedUris,
  localUploadFileName,
  SftpDragAndDropController
} from '../../src/sftp/SftpDragAndDropController';
import { SftpConflictError } from '../../src/sftp/SftpErrors';
import type { SftpManager } from '../../src/sftp/SftpManager';

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

describe('SftpDragAndDropController conflict handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeController(uploadFile: SftpManager['uploadFile']) {
    const manager = {
      getState: () => ({ kind: 'active' as const, rootPath: '/root' }),
      uploadFile
    } as unknown as SftpManager;
    return { controller: new SftpDragAndDropController(manager), manager };
  }

  function dropTransfer(...uris: string[]) {
    return new Map([['text/uri-list', { asString: async () => uris.join('\r\n') }]]) as never;
  }

  it('prompts to overwrite when the upload hits an existing remote file', async () => {
    const uploadFile = vi
      .fn<SftpManager['uploadFile']>()
      .mockRejectedValueOnce(new SftpConflictError('/root/a.txt'))
      .mockResolvedValueOnce(undefined);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Overwrite' as never);
    const { controller } = makeController(uploadFile);

    await controller.handleDrop(undefined, dropTransfer('file:///home/alan/a.txt'), {} as never);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenNthCalledWith(1, '/home/alan/a.txt', '/root/a.txt', undefined, {
      overwrite: false
    });
    expect(uploadFile).toHaveBeenNthCalledWith(2, '/home/alan/a.txt', '/root/a.txt', undefined, {
      overwrite: true
    });
  });

  it('skips the conflicting file without failing the drop when the user declines', async () => {
    const uploadFile = vi
      .fn<SftpManager['uploadFile']>()
      .mockRejectedValueOnce(new SftpConflictError('/root/a.txt'))
      .mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Skip' as never);
    const { controller } = makeController(uploadFile);

    await controller.handleDrop(
      undefined,
      dropTransfer('file:///home/alan/a.txt', 'file:///home/alan/b.txt'),
      {} as never
    );

    // a.txt is skipped after the prompt; b.txt still uploads.
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile).toHaveBeenLastCalledWith('/home/alan/b.txt', '/root/b.txt', undefined, {
      overwrite: false
    });
  });

  it('remembers Overwrite All for the remaining dropped files', async () => {
    const uploadFile = vi
      .fn<SftpManager['uploadFile']>()
      .mockRejectedValueOnce(new SftpConflictError('/root/a.txt'))
      .mockResolvedValue(undefined);
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Overwrite All' as never);
    const { controller } = makeController(uploadFile);

    await controller.handleDrop(
      undefined,
      dropTransfer('file:///home/alan/a.txt', 'file:///home/alan/b.txt'),
      {} as never
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenLastCalledWith('/home/alan/b.txt', '/root/b.txt', undefined, {
      overwrite: true
    });
  });

  it('still rethrows non-conflict upload failures', async () => {
    const uploadFile = vi.fn<SftpManager['uploadFile']>().mockRejectedValue(new Error('EACCES'));
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const { controller } = makeController(uploadFile);

    await expect(
      controller.handleDrop(undefined, dropTransfer('file:///home/alan/a.txt'), {} as never)
    ).rejects.toThrow('EACCES');
    expect(warn).not.toHaveBeenCalled();
  });
});
