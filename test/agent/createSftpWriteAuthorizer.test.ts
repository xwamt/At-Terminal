import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createProductionSftpWriteAuthorizer } from '../../src/agent/createSftpWriteAuthorizer';
import { SftpWriteAuthorizer } from '../../src/agent/SftpWriteAuthorizer';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Production',
    host: 'prod.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('createProductionSftpWriteAuthorizer', () => {
  it('returns a real SftpWriteAuthorizer instance', () => {
    expect(createProductionSftpWriteAuthorizer()).toBeInstanceOf(SftpWriteAuthorizer);
  });

  it('uses the default confirm path and rejects when the user cancels', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const authorizer = createProductionSftpWriteAuthorizer();

    await expect(
      authorizer.requireWrite(server(), {
        operation: 'write_file',
        path: '/app/a.txt',
        overwrite: false,
        workspaceRoot: '/app'
      })
    ).rejects.toThrow('SFTP write was cancelled.');

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });

  it('offers the three scopes with the least privileged one as the default button', async () => {
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const authorizer = createProductionSftpWriteAuthorizer();

    await expect(
      authorizer.requireWrite(server(), {
        operation: 'write_file',
        path: '/app/a.txt',
        overwrite: false,
        workspaceRoot: '/app'
      })
    ).rejects.toThrow('SFTP write was cancelled.');

    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Path: /app/a.txt'),
      { modal: true },
      'Allow Once',
      'Allow This Folder For 15 Minutes',
      'Allow This Folder For The Session'
    );
  });

  it('highlights a write that leaves the session working directory', async () => {
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const authorizer = createProductionSftpWriteAuthorizer();

    await expect(
      authorizer.requireWrite(server(), {
        operation: 'write_file',
        path: '/var/www/html/index.html',
        overwrite: true,
        workspaceRoot: '/app'
      })
    ).rejects.toThrow('SFTP write was cancelled.');

    const message = vi.mocked(showWarningMessage).mock.calls[0][0] as string;
    expect(message).toContain('WARNING: outside the working directory /app');
    expect(showWarningMessage).toHaveBeenCalledWith(
      expect.any(String),
      { modal: true },
      'Allow Once',
      'Allow This Folder For 15 Minutes'
    );
  });

  it('runs a sensitive write through a second dialog that cannot be remembered', async () => {
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValueOnce('Allow Once' as never)
      .mockResolvedValueOnce(undefined);
    const authorizer = createProductionSftpWriteAuthorizer();

    await expect(
      authorizer.requireWrite(server(), {
        operation: 'write_file',
        path: '/app/.ssh/authorized_keys',
        overwrite: true,
        workspaceRoot: '/app'
      })
    ).rejects.toThrow('SFTP write was cancelled.');

    expect(showWarningMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(showWarningMessage).mock.calls[0][0]).toContain('WARNING: sensitive system path');
    expect(vi.mocked(showWarningMessage).mock.calls[1][0]).toContain('never remembered');
    expect(vi.mocked(showWarningMessage).mock.calls[1]).toContain('Write It Anyway, Once');
  });
});
