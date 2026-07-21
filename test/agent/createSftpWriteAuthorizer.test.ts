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
        overwrite: false
      })
    ).rejects.toThrow('SFTP write was cancelled.');

    expect(vscode.window.showWarningMessage).toHaveBeenCalled();
  });
});
