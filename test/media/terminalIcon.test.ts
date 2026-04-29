import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AT Terminal package branding', () => {
  it('uses AT Terminal metadata and branded extension icon', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      name: string;
      displayName: string;
      description: string;
      icon: string;
      contributes: { configuration: { title: string } };
    };
    const iconPath = manifest.icon;

    expect(manifest.name).toBe('at-terminal');
    expect(manifest.displayName).toBe('AT Terminal');
    expect(manifest.description).toBe('Agentless SSH terminal and SFTP workspace for VS Code.');
    expect(manifest.contributes.configuration.title).toBe('AT Terminal');
    expect(iconPath).toBe('media/at-terminal-icon.png');
    expect(existsSync(join(process.cwd(), iconPath))).toBe(true);
  });

  it('uses a currentColor template icon for VS Code activity bar theming', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { viewsContainers: { activitybar: Array<{ icon: string }> } };
    };
    const iconPath = manifest.contributes.viewsContainers.activitybar[0].icon;
    const absoluteIconPath = join(process.cwd(), iconPath);
    const svg = readFileSync(absoluteIconPath, 'utf8');

    expect(existsSync(absoluteIconPath)).toBe(true);
    expect(iconPath).toBe('media/at-terminal-activity.svg');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
