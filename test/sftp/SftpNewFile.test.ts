import { describe, expect, it, vi } from 'vitest';
import { createRemoteFileForEditing } from '../../src/sftp/SftpNewFile';

describe('createRemoteFileForEditing', () => {
  it('creates a named remote file in the target directory and opens it for editing', async () => {
    const calls: string[] = [];

    const remotePath = await createRemoteFileForEditing({
      entry: { path: '/srv/app', type: 'directory' },
      rootPath: '/srv',
      promptName: vi.fn(async () => 'main.ts'),
      createFile: vi.fn(async (path) => {
        calls.push(`create:${path}`);
      }),
      openRemoteFile: vi.fn(async (path) => {
        calls.push(`edit:${path}`);
      }),
      refresh: vi.fn(() => {
        calls.push('refresh');
      })
    });

    expect(remotePath).toBe('/srv/app/main.ts');
    expect(calls).toEqual(['create:/srv/app/main.ts', 'refresh', 'edit:/srv/app/main.ts']);
  });

  it('creates a named remote file beside a selected file', async () => {
    const createFile = vi.fn();
    const openRemoteFile = vi.fn();

    await createRemoteFileForEditing({
      entry: { path: '/srv/app/app.js', type: 'file' },
      rootPath: '/srv',
      promptName: vi.fn(async () => 'new.js'),
      createFile,
      openRemoteFile,
      refresh: vi.fn()
    });

    expect(createFile).toHaveBeenCalledWith('/srv/app/new.js');
    expect(openRemoteFile).toHaveBeenCalledWith('/srv/app/new.js');
  });

  it('does nothing when the user cancels naming', async () => {
    const createFile = vi.fn();
    const openRemoteFile = vi.fn();

    await expect(
      createRemoteFileForEditing({
        rootPath: '/srv',
        promptName: vi.fn(async () => undefined),
        createFile,
        openRemoteFile,
        refresh: vi.fn()
      })
    ).resolves.toBeUndefined();

    expect(createFile).not.toHaveBeenCalled();
    expect(openRemoteFile).not.toHaveBeenCalled();
  });
});
