import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const rootManifest = JSON.parse(readFileSync('package.json', 'utf8'));
const mcpManifest = JSON.parse(readFileSync('package.mcp.json', 'utf8'));

describe('agent tool package contributions', () => {
  it('does not contribute VS Code languageModelTools', () => {
    for (const manifest of [rootManifest, mcpManifest]) {
      expect(manifest.activationEvents.every((event: string) => !event.startsWith('onLanguageModelTool:'))).toBe(
        true
      );
      expect(manifest.contributes.languageModelTools).toBeUndefined();
      expect(JSON.stringify(manifest.contributes)).not.toContain('languageModelTools');
    }
    expect(mcpManifest.activationEvents).toContain('onStartupFinished');
  });
});
