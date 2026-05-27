import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifests = [
  JSON.parse(readFileSync('package.json', 'utf8')),
  JSON.parse(readFileSync('package.base.json', 'utf8')),
  JSON.parse(readFileSync('package.mcp.json', 'utf8'))
];

describe('asset import/export package contributions', () => {
  it('contributes asset import/export commands in all variants', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.exportAssets', title: 'AT Terminal: Export Assets' }),
          expect.objectContaining({ command: 'sshManager.importAssets', title: 'AT Terminal: Import Assets' })
        ])
      );
    }
  });

  it('shows asset import/export actions in the Servers view title in all variants', () => {
    for (const manifest of manifests) {
      expect(manifest.contributes.menus['view/title']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ command: 'sshManager.exportAssets', when: 'view == sshManager.servers' }),
          expect.objectContaining({ command: 'sshManager.importAssets', when: 'view == sshManager.servers' })
        ])
      );
    }
  });
});
