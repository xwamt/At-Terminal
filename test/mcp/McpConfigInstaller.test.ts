import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildContinueMcpConfig,
  installContinueMcpConfig,
  installKiroMcpConfig,
  kiroMcpConfigPath,
  ensureKiroMcpConfig
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
    const mcpServerPath = await createMcpServerBundle(root);

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath
    });

    await expect(readFile(configPath, 'utf8')).resolves.toContain('dist/mcp-server.js');
  });

  it('replaces existing AT Terminal config file content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-terminal-mcp-config-'));
    const dir = join(root, '.continue', 'mcpServers');
    const mcpServerPath = await createMcpServerBundle(root);
    await mkdir(dir, { recursive: true });
    const configPath = join(dir, 'at-terminal.yaml');
    await writeFile(configPath, 'old', 'utf8');

    await installContinueMcpConfig({
      workspaceFolder: root,
      mcpServerPath
    });

    await expect(readFile(configPath, 'utf8')).resolves.not.toBe('old');
  });

  it('updates Kiro user MCP config with all AT Terminal tools and current server path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const configPath = kiroMcpConfigPath(home);
    const mcpServerPath = await createKiroMcpServerBundle(home, '0.2.10');
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
      mcpServerPath
    });

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers.fetch).toMatchObject({ command: 'uvx', disabled: true });
    expect(parsed.mcpServers['AT Terminal']).toEqual({
      command: 'node',
      args: [normalizePath(mcpServerPath)],
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

  it('repairs stale Kiro AT Terminal config with the current server path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const configPath = kiroMcpConfigPath(home);
    const mcpServerPath = await createKiroMcpServerBundle(home, '2.10.0');
    await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fetch: { command: 'uvx', args: ['mcp-server-fetch'], disabled: true },
          'AT Terminal': {
            command: 'node',
            args: ['C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js'],
            autoApprove: ['run_remote_command']
          }
        }
      }),
      'utf8'
    );

    await expect(
      ensureKiroMcpConfig({
        home,
        mcpServerPath
      })
    ).resolves.toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers.fetch).toMatchObject({ command: 'uvx', disabled: true });
    expect(parsed.mcpServers['AT Terminal'].args).toEqual([normalizePath(mcpServerPath)]);
    expect(parsed.mcpServers['AT Terminal'].autoApprove).toContain('sftp_write_file');
  });

  it('repairs Kiro MCP config files that start with a UTF-8 BOM', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const configPath = kiroMcpConfigPath(home);
    const mcpServerPath = await createKiroMcpServerBundle(home, '2.10.0');
    await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
    await writeFile(
      configPath,
      `\uFEFF${JSON.stringify({
        mcpServers: {
          'AT Terminal': {
            command: 'node',
            args: ['C:/Users/alan/.kiro/extensions/local.at-terminal-mcp-0.2.9/dist/mcp-server.js'],
            autoApprove: ['run_remote_command']
          }
        }
      })}`,
      'utf8'
    );

    await expect(
      ensureKiroMcpConfig({
        home,
        mcpServerPath
      })
    ).resolves.toBe(configPath);

    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    expect(parsed.mcpServers['AT Terminal'].args).toEqual([normalizePath(mcpServerPath)]);
  });

  it('leaves current Kiro AT Terminal config unchanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const configPath = kiroMcpConfigPath(home);
    const mcpServerPath = await createKiroMcpServerBundle(home, '2.10.0');
    await mkdir(join(home, '.kiro', 'settings'), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          'AT Terminal': {
            command: 'node',
            args: [normalizePath(mcpServerPath)],
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
          }
        }
      }),
      'utf8'
    );
    const before = await readFile(configPath, 'utf8');

    await expect(
      ensureKiroMcpConfig({
        home,
        mcpServerPath
      })
    ).resolves.toBeUndefined();

    await expect(readFile(configPath, 'utf8')).resolves.toBe(before);
  });

  it('waits for the MCP server bundle before writing Kiro config during extension install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const mcpServerPath = join(home, '.kiro', 'extensions', 'local.at-terminal-mcp-2.10.0', 'dist', 'mcp-server.js');
    setTimeout(() => {
      void mkdir(join(home, '.kiro', 'extensions', 'local.at-terminal-mcp-2.10.0', 'dist'), { recursive: true }).then(() =>
        writeFile(mcpServerPath, '// bundled server\n', 'utf8')
      );
    }, 25);

    await expect(
      ensureKiroMcpConfig({
        home,
        mcpServerPath,
        waitForServerMs: 1_000,
        pollIntervalMs: 5
      })
    ).resolves.toBe(kiroMcpConfigPath(home));

    const parsed = JSON.parse(await readFile(kiroMcpConfigPath(home), 'utf8'));
    expect(parsed.mcpServers['AT Terminal'].args).toEqual([normalizePath(mcpServerPath)]);
  });

  it('does not write MCP config when the bundled server entry file never appears', async () => {
    const home = await mkdtemp(join(tmpdir(), 'at-terminal-kiro-config-'));
    const mcpServerPath = join(home, '.kiro', 'extensions', 'local.at-terminal-mcp-2.10.0', 'dist', 'mcp-server.js');

    await expect(
      ensureKiroMcpConfig({
        home,
        mcpServerPath,
        waitForServerMs: 1,
        pollIntervalMs: 1
      })
    ).rejects.toThrow('AT Terminal MCP server bundle is missing');
  });
});

async function createMcpServerBundle(root: string): Promise<string> {
  const mcpServerPath = join(root, 'dist', 'mcp-server.js');
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(mcpServerPath, '// bundled server\n', 'utf8');
  return mcpServerPath;
}

async function createKiroMcpServerBundle(home: string, version: string): Promise<string> {
  const extensionRoot = join(home, '.kiro', 'extensions', `local.at-terminal-mcp-${version}`);
  return createMcpServerBundle(extensionRoot);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
