import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * The base variant is the agentless product. Manifest-level checks live in
 * package.variants.test.ts; this file asserts on the artifact itself, because the
 * manifest can be clean while `MCP_ENABLED` still fails to fold and drags the whole
 * bridge into the bundle.
 *
 * Assertions use string literals rather than identifiers: a minified bundle renames
 * `createBridgeRequestHandler` regardless of whether its body survived.
 *
 * Known residue: `@at-series/mcp-hub` is CommonJS, and esbuild keeps a statically
 * imported CJS module even when every consumer is eliminated. Its constants and the
 * tool catalog therefore still appear in the base bundle even though no code path can
 * reach them. Only assertions that actually hold belong here.
 */
let baseBundle = '';
let mcpBundle = '';

function build(variant: 'base' | 'mcp'): string {
  execFileSync(process.execPath, ['esbuild.config.mjs', `--variant=${variant}`], { stdio: 'pipe' });
  return readFileSync('dist/extension.js', 'utf8');
}

beforeAll(() => {
  mcpBundle = build('mcp');
  baseBundle = build('base');
}, 120_000);

describe('base variant bundle', () => {
  it('drops the MCP bridge instead of shipping it behind a disabled flag', () => {
    expect(mcpBundle).toContain('Unauthorized MCP bridge request.');
    expect(baseBundle).not.toContain('createBridgeRequestHandler');
    expect(baseBundle).not.toContain('Unauthorized MCP bridge request.');
    expect(baseBundle).not.toContain('AT Terminal MCP bridge');
  });

  it('drops the MCP config install and uninstall commands', () => {
    expect(mcpBundle).toContain('sshManager.installMcpConfig');
    expect(baseBundle).not.toContain('sshManager.installMcpConfig');
    expect(baseBundle).not.toContain('sshManager.uninstallAtSeriesMcpConfig');
  });

  it('is meaningfully smaller than the MCP variant', () => {
    expect(baseBundle.length).toBeLessThan(mcpBundle.length * 0.95);
  });

  it('ships a minified bundle', () => {
    const { size } = statSync('dist/extension.js');
    const averageLineLength = size / (baseBundle.split('\n').length || 1);

    expect(averageLineLength).toBeGreaterThan(200);
  });

  it('leaves no sourceMappingURL behind, since .vscodeignore keeps maps out of the VSIX', () => {
    expect(readFileSync('.vscodeignore', 'utf8')).toContain('**/*.map');
    expect(baseBundle).not.toContain('sourceMappingURL');
  });
});
