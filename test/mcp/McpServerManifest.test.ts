import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const buildConfig = readFileSync('esbuild.config.mjs', 'utf8');
const vscodeIgnore = readFileSync('.vscodeignore', 'utf8');

describe('MCP server packaging metadata', () => {
  it('declares the official MCP SDK dependency', () => {
    expect(manifest.dependencies['@modelcontextprotocol/sdk']).toEqual(expect.any(String));
  });

  it('builds a dist mcp-server entrypoint', () => {
    expect(buildConfig).toContain("entryPoints: ['src/mcp/server.ts']");
    expect(buildConfig).toContain("outfile: 'dist/mcp-server.js'");
  });

  it('does not ignore the bundled MCP server', () => {
    expect(vscodeIgnore).not.toMatch(/^dist\/mcp-server\.js$/m);
  });
});
