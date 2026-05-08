import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildContinueMcpConfig,
  installContinueMcpConfig,
  installKiroMcpConfig,
  kiroMcpConfigPath
} from '../../src/mcp/McpConfigInstaller';

describe('McpConfigInstaller', () => {
  it('builds Continue MCP config with normalized mcp server path', () => {
    expect(
      buildContinueMcpConfig('C:\\Users\\alan\\.vscode\\extensions\\local.at-terminal-0.2.10\\dist\\mcp-server.js')
    ).toContain('C:/Users/alan/.vscode/extensions/local.at-terminal-0.2.10/dist/mcp-server.js');
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

  it('updates Kiro user MCP config with all AT Terminal tools and current server path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const configPath = kiroMcpConfigPath(home);
    await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        name: 'AT Terminal MCP',
        version: '0.0.1',
        schema: 'v1',
        mcpServers: {
          fetch: { command: 'uvx', args: ['mcp-server-fetch'], disabled: true },
          'AT Terminal': {
            command: 'node',
            args: ['C:/Users/alan/.vscode/extensions/local.at-terminal-0.2.10/dist/mcp-server.js'],
            autoApprove: ['run_remote_command', 'list_ssh_servers']
          }
        }
      }),
      'utf8'
    );

    await installKiroMcpConfig({
      home,
      mcpServerPath: 'C:\\Users\\alan\\.kiro\\extensions\\local.at-terminal-mcp-0.2.10\\dist\\mcp-server.js'
    });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers.fetch).toMatchObject({ command: 'uvx', disabled: true });
    expect(parsed.mcpServers['AT Terminal']).toEqual({
      command: 'node',
      args: ['C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.10/dist/mcp-server.js'],
      autoApprove: [
        'list_ssh_servers',
        'get_terminal_context',
        'run_remote_command',
        'sftp_list_directory',
        'sftp_stat_path',
        'sftp_read_file',
        'sftp_write_file',
        'sftp_create_file',
        'sftp_create_directory'
      ]
    });
  });
});
