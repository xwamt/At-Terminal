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
    expect(packageJson).toContain('copy:policy-assets');
    expect(packageJson).toContain('@at-series/mcp-hub');
    expect(packageJson).toContain('"@at-series/command-policy": "0.1.0"');
    expect(packageJson).not.toContain('"@at-series/command-policy": "^');
    expect(packageJson).not.toContain('file:../at-series-command-policy');
    expect(copyHubScript).toContain("join('dist', 'hub.js')");
    expect(copyHubScript).toContain('@at-series/mcp-hub/hub');
  });

  it('requires hub.js and policy runtime assets when packaging the MCP variant', () => {
    expect(packageScript).toContain("join(stage, 'dist', 'hub.js')");
    expect(packageScript).toContain("variant === 'mcp'");
    expect(packageScript).toContain('policy-runtime.js');
    expect(packageScript).toContain('policy-assets');
  });

  it('does not keep a source mcp-server entrypoint', () => {
    expect(existsSync('src/mcp/server.ts')).toBe(false);
  });

  it('does not keep the old plugin-local command lexer or blocklist', () => {
    expect(existsSync('src/agent/remoteCommandPolicy.ts')).toBe(false);
    expect(existsSync('src/agent/shellCommandLexer.ts')).toBe(false);
  });
});
