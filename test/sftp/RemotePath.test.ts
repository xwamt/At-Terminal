import { describe, expect, it } from 'vitest';
import { dirname, joinRemotePath, quotePosixShellPath, safePreviewName } from '../../src/sftp/RemotePath';

describe('RemotePath', () => {
  it('joins POSIX remote paths without using Windows separators', () => {
    expect(joinRemotePath('/home/deploy/', 'app.log')).toBe('/home/deploy/app.log');
  });

  it('gets parent directory paths', () => {
    expect(dirname('/home/deploy/app.log')).toBe('/home/deploy');
    expect(dirname('/app.log')).toBe('/');
  });

  it('quotes POSIX shell paths safely', () => {
    expect(quotePosixShellPath("/tmp/it's here")).toBe("'/tmp/it'\"'\"'s here'");
  });

  it('sanitizes preview file names', () => {
    expect(safePreviewName('../../etc/passwd')).toBe('passwd');
    expect(safePreviewName('bad:name?.txt')).toBe('bad_name_.txt');
  });
});
