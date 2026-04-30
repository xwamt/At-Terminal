import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

describe('agent tool package contributions', () => {
  it('activates and contributes SSH language model tools', () => {
    expect(manifest.activationEvents).toContain('onLanguageModelTool:list_ssh_servers');
    expect(manifest.activationEvents).toContain('onLanguageModelTool:get_terminal_context');
    expect(manifest.activationEvents).toContain('onLanguageModelTool:run_remote_command');
    for (const tool of [
      'sftp_list_directory',
      'sftp_stat_path',
      'sftp_read_file',
      'sftp_write_file',
      'sftp_create_file',
      'sftp_create_directory'
    ]) {
      expect(manifest.activationEvents).toContain(`onLanguageModelTool:${tool}`);
    }
    expect(manifest.contributes.languageModelTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'list_ssh_servers',
          tags: ['ssh', 'server', 'read-only'],
          canBeReferencedInPrompt: true,
          toolReferenceName: 'list_ssh_servers',
          userDescription: expect.any(String)
        }),
        expect.objectContaining({
          name: 'get_terminal_context',
          tags: ['ssh', 'terminal', 'read-only'],
          canBeReferencedInPrompt: true,
          toolReferenceName: 'get_terminal_context',
          userDescription: expect.any(String)
        }),
        expect.objectContaining({
          name: 'run_remote_command',
          tags: ['ssh', 'terminal', 'remote'],
          canBeReferencedInPrompt: true,
          toolReferenceName: 'run_remote_command',
          userDescription: expect.any(String)
        }),
        ...[
          'sftp_list_directory',
          'sftp_stat_path',
          'sftp_read_file',
          'sftp_write_file',
          'sftp_create_file',
          'sftp_create_directory'
        ].map((name) =>
          expect.objectContaining({
            name,
            canBeReferencedInPrompt: true,
            toolReferenceName: name,
            userDescription: expect.any(String)
          })
        )
      ])
    );
  });
});
