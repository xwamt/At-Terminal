import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = readFileSync('package.json', 'utf8');
const buildConfig = readFileSync('esbuild.config.mjs', 'utf8');
const packageScript = readFileSync('scripts/package-variant.mjs', 'utf8');
const copyHubScript = readFileSync('scripts/copy-hub.mjs', 'utf8');

describe('MCP hub packaging metadata', () => {
  it('builds MCP extension without a per-plugin mcp-server entry', () => {
    expect(buildConfig).not.toContain("entryPoints: ['src/mcp/server.ts']");
    expect(buildConfig).not.toContain("outfile: 'dist/mcp-server.js'");
    expect(packageJson).toContain('copy:hub');
    expect(packageJson).toContain('@at-series/mcp-hub');
    expect(copyHubScript).toContain("join('dist', 'hub.js')");
    expect(copyHubScript).toContain('@at-series/mcp-hub/hub');
  });

  it('requires hub.js when packaging the MCP variant', () => {
    expect(packageScript).toContain("join(stage, 'dist', 'hub.js')");
    expect(packageScript).toContain("variant === 'mcp'");
  });

  it('does not keep a source mcp-server entrypoint', () => {
    expect(existsSync('src/mcp/server.ts')).toBe(false);
  });
});
