import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildContinueMcpConfig, installContinueMcpConfig } from '../../src/mcp/McpConfigInstaller';

describe('McpConfigInstaller', () => {
  it('builds Continue MCP config with normalized mcp server path', () => {
    expect(
      buildContinueMcpConfig('C:\\Users\\alan\\.vscode\\extensions\\local.at-terminal-0.2.9\\dist\\mcp-server.js')
    ).toContain('C:/Users/alan/.vscode/extensions/local.at-terminal-0.2.9/dist/mcp-server.js');
  });

  it('creates workspace Continue MCP config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-config-'));
    const configPath = join(root, '.continue', 'mcpServers', 'at-terminal.yaml');

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath: join(root, 'dist', 'mcp-server.js')
    });

    await expect(readFile(configPath, 'utf8')).resolves.toContain('dist/mcp-server.js');
  });

  it('replaces existing AT Terminal config file content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-config-'));
    const dir = join(root, '.continue', 'mcpServers');
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, 'at-terminal.yaml');
    await writeFile(configPath, 'old', 'utf8');

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath: join(root, 'dist', 'mcp-server.js')
    });

    await expect(readFile(configPath, 'utf8')).resolves.not.toBe('old');
  });
});
