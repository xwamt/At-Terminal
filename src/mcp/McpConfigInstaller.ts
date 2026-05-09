import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface InstallContinueMcpConfigOptions {
  workspaceFolder: string;
  mcpServerPath: string;
}

export interface InstallKiroMcpConfigOptions {
  home?: string;
  mcpServerPath: string;
}

export const AT_TERMINAL_MCP_TOOL_NAMES = [
  'list_ssh_servers',
  'get_terminal_context',
  'run_remote_command',
  'sftp_list_directory',
  'sftp_stat_path',
  'sftp_read_file',
  'sftp_write_file',
  'sftp_create_file',
  'sftp_create_directory'
];

export function buildContinueMcpConfig(mcpServerPath: string): string {
  const normalized = mcpServerPath.replaceAll('\\', '/');
  return `name: AT Terminal MCP
version: 0.0.1
schema: v1
mcpServers:
  - name: AT Terminal
    command: node
    args:
      - ${normalized}
`;
}

export function continueMcpConfigPath(workspaceFolder: string): string {
  return join(workspaceFolder, '.continue', 'mcpServers', 'at-terminal.yaml');
}

export async function installContinueMcpConfig(options: InstallContinueMcpConfigOptions): Promise<string> {
  const target = continueMcpConfigPath(options.workspaceFolder);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buildContinueMcpConfig(options.mcpServerPath), 'utf8');
  return target;
}

export function kiroMcpConfigPath(home = homedir()): string {
  return join(home, '.kiro', 'settings', 'mcp.json');
}

export async function installKiroMcpConfig(options: InstallKiroMcpConfigOptions): Promise<string> {
  const target = kiroMcpConfigPath(options.home);
  const config = await readJsonObject(target);
  const mcpServers = readMcpServers(config);
  config.name = typeof config.name === 'string' ? config.name : 'AT Terminal MCP';
  config.version = typeof config.version === 'string' ? config.version : '0.0.1';
  config.schema = typeof config.schema === 'string' ? config.schema : 'v1';
  config.mcpServers = {
    ...mcpServers,
    'AT Terminal': {
      command: 'node',
      args: [normalizePath(options.mcpServerPath)],
      autoApprove: AT_TERMINAL_MCP_TOOL_NAMES
    }
  };
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return target;
}

export async function ensureKiroMcpConfig(options: InstallKiroMcpConfigOptions): Promise<string | undefined> {
  const target = kiroMcpConfigPath(options.home);
  const config = await readJsonObject(target);
  const server = readMcpServers(config)['AT Terminal'];
  if (hasCurrentKiroMcpServer(server, options.mcpServerPath)) {
    return undefined;
  }
  return installKiroMcpConfig(options);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(stripJsonBom(text)) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function stripJsonBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMcpServers(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.mcpServers) ? config.mcpServers : {};
}

function hasCurrentKiroMcpServer(value: unknown, mcpServerPath: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.command !== 'node') {
    return false;
  }
  if (!Array.isArray(value.args) || value.args[0] !== normalizePath(mcpServerPath)) {
    return false;
  }
  const autoApprove = value.autoApprove;
  if (!Array.isArray(autoApprove)) {
    return false;
  }
  return AT_TERMINAL_MCP_TOOL_NAMES.every((toolName) => autoApprove.includes(toolName));
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}
