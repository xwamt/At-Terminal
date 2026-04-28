import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

describe('SFTP package contributions', () => {
  it('contributes the SFTP Files view and commands', () => {
    expect(pkg.contributes.views.sshManager).toContainEqual({
      id: 'sshManager.sftpFiles',
      name: 'SFTP Files',
      visibility: 'visible'
    });
    expect(pkg.contributes.commands.map((entry: { command: string }) => entry.command)).toEqual(
      expect.arrayContaining([
        'sshManager.sftp.refresh',
        'sshManager.sftp.upload',
        'sshManager.sftp.download',
        'sshManager.sftp.delete',
        'sshManager.sftp.rename',
        'sshManager.sftp.newFile',
        'sshManager.sftp.newFolder',
        'sshManager.sftp.copyPath',
        'sshManager.sftp.edit',
        'sshManager.sftp.openPreview',
        'sshManager.sftp.cdToDirectory',
        'sshManager.sftp.goToPath',
        'sshManager.sftp.goUp'
      ])
    );
    expect(pkg.contributes.menus['view/item/context']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'sshManager.sftp.edit',
          when: 'view == sshManager.sftpFiles && viewItem == sftpFile',
          group: 'open@1'
        }),
        expect.objectContaining({
          command: 'sshManager.sftp.newFile',
          when: 'view == sshManager.sftpFiles && (viewItem == sftpDirectory || viewItem == sftpFile)',
          group: 'management@1'
        })
      ])
    );
  });
});
