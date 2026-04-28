import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('activity bar terminal icon', () => {
  it('uses a filled currentColor template icon for VS Code activity bar theming', () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { viewsContainers: { activitybar: Array<{ icon: string }> } };
    };
    const iconPath = manifest.contributes.viewsContainers.activitybar[0].icon;
    const absoluteIconPath = join(process.cwd(), iconPath);
    const svg = readFileSync(absoluteIconPath, 'utf8');

    expect(existsSync(absoluteIconPath)).toBe(true);
    expect(iconPath).toBe('media/terminal-activity.svg');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('stroke=');
    expect(svg).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
