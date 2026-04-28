import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('SFTP package contributions', () => {
  it('contributes the SFTP Files view and commands', () => {
    expect(pkg.contributes.views.sshManager).toContainEqual({
      id: 'sshManager.sftpFiles',
      name: 'SFTP Files'
    });
    expect(pkg.contributes.commands.map((entry: { command: string }) => entry.command)).toEqual(
      expect.arrayContaining([
        'sshManager.sftp.refresh',
        'sshManager.sftp.upload',
        'sshManager.sftp.download',
        'sshManager.sftp.delete',
        'sshManager.sftp.rename',
        'sshManager.sftp.newFolder',
        'sshManager.sftp.copyPath',
        'sshManager.sftp.openPreview',
        'sshManager.sftp.cdToDirectory'
      ])
    );
  });
});
