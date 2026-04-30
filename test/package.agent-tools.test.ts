import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

describe('agent tool package contributions', () => {
  it('activates and contributes SSH language model tools', () => {
    expect(manifest.activationEvents).toContain('onLanguageModelTool:list_ssh_servers');
    expect(manifest.activationEvents).toContain('onLanguageModelTool:run_remote_command');
    expect(manifest.contributes.languageModelTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'list_ssh_servers',
          tags: ['ssh', 'server', 'read-only']
        }),
        expect.objectContaining({
          name: 'run_remote_command',
          tags: ['ssh', 'terminal', 'remote']
        })
      ])
    );
  });
});
