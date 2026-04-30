import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const baseManifest = JSON.parse(readFileSync('package.base.json', 'utf8'));
const mcpManifest = JSON.parse(readFileSync('package.mcp.json', 'utf8'));
const packageScript = readFileSync('scripts/package-variant.mjs', 'utf8');
const buildConfig = readFileSync('esbuild.config.mjs', 'utf8');
const extensionSource = readFileSync('src/extension.ts', 'utf8');

describe('package variants', () => {
  it('keeps the base manifest free of agent and MCP contributions', () => {
    expect(baseManifest.displayName).toBe('AT Terminal');
    expect(baseManifest.activationEvents).not.toContain('onLanguageModelTool:list_ssh_servers');
    expect(JSON.stringify(baseManifest.contributes)).not.toContain('languageModelTools');
    expect(baseManifest.dependencies['@modelcontextprotocol/sdk']).toBeUndefined();
  });

  it('keeps the MCP manifest as the only manifest with agent and MCP contributions', () => {
    expect(mcpManifest.displayName).toBe('AT Terminal MCP');
    expect(mcpManifest.activationEvents).toContain('onLanguageModelTool:list_ssh_servers');
    expect(JSON.stringify(mcpManifest.contributes.languageModelTools)).toContain('list_ssh_servers');
  });

  it('keeps the MCP config command only in the MCP manifest', () => {
    expect(JSON.stringify(baseManifest.contributes)).not.toContain('sshManager.installMcpConfig');
    expect(JSON.stringify(mcpManifest.contributes.commands)).toContain('sshManager.installMcpConfig');
  });

  it('builds the MCP server only for the MCP variant', () => {
    expect(buildConfig).toContain('--variant=mcp');
    expect(buildConfig).toContain('src/mcp/server.ts');
    expect(buildConfig).toContain('dist/mcp-server.js');
  });

  it('guards extension MCP runtime behind a build flag', () => {
    expect(extensionSource).toContain('MCP_ENABLED');
    expect(extensionSource).toContain('if (MCP_ENABLED)');
  });

  it('stages package variants before running vsce', () => {
    expect(packageScript).toContain('package.base.json');
    expect(packageScript).toContain('package.mcp.json');
    expect(packageScript).toContain('vsce');
  });

  it('packages the base and MCP variants with their own README files', () => {
    expect(packageScript).toContain("variant === 'base' ? 'README-base.md' : 'README.md'");
    expect(packageScript).toContain("join(root, readmeName)");
    expect(packageScript).toContain("join(stage, 'README.md')");
  });
});
