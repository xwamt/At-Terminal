import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifests = [
  JSON.parse(readFileSync('package.json', 'utf8')),
  JSON.parse(readFileSync('package.base.json', 'utf8')),
  JSON.parse(readFileSync('package.mcp.json', 'utf8'))
];

describe('SFTP package contributions', () => {
  it('contributes the SFTP Files view and commands', () => {
    for (const pkg of manifests) {
      expect(pkg.contributes.views.sshManager).toContainEqual({
        id: 'sshManager.sftpFiles',
        name: '%atTerminal.view.sftpFiles.name%',
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
            command: 'sshManager.addServer',
            when: 'view == sshManager.servers && viewItem == group',
            group: 'management@1'
          }),
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
    }
  });

  it('uses icons for SFTP commands and view title actions in all variants', () => {
    for (const pkg of manifests) {
      expect(pkg.contributes.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.sftp.refresh', icon: '$(refresh)' }),
          expect.objectContaining({ command: 'sshManager.sftp.upload', icon: '$(cloud-upload)' }),
          expect.objectContaining({ command: 'sshManager.sftp.download', icon: '$(cloud-download)' }),
          expect.objectContaining({ command: 'sshManager.sftp.delete', icon: '$(trash)' }),
          expect.objectContaining({ command: 'sshManager.sftp.rename', icon: '$(edit)' }),
          expect.objectContaining({ command: 'sshManager.sftp.newFile', icon: '$(new-file)' }),
          expect.objectContaining({ command: 'sshManager.sftp.newFolder', icon: '$(new-folder)' }),
          expect.objectContaining({ command: 'sshManager.sftp.copyPath', icon: '$(copy)' }),
          expect.objectContaining({ command: 'sshManager.sftp.edit', icon: '$(edit)' }),
          expect.objectContaining({ command: 'sshManager.sftp.openPreview', icon: '$(open-preview)' }),
          expect.objectContaining({ command: 'sshManager.sftp.cdToDirectory', icon: '$(terminal)' }),
          expect.objectContaining({ command: 'sshManager.sftp.goToPath', icon: '$(folder-opened)' }),
          expect.objectContaining({ command: 'sshManager.sftp.goUp', icon: '$(arrow-up)' })
        ])
      );

      expect(pkg.contributes.menus['view/title']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.sftp.refresh', when: 'view == sshManager.sftpFiles' }),
          expect.objectContaining({ command: 'sshManager.sftp.upload', when: 'view == sshManager.sftpFiles' }),
          expect.objectContaining({ command: 'sshManager.sftp.goUp', when: 'view == sshManager.sftpFiles' }),
          expect.objectContaining({ command: 'sshManager.sftp.goToPath', when: 'view == sshManager.sftpFiles' })
        ])
      );
    }
  });
});
