import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface InstallContinueMcpConfigOptions {
  workspaceFolder: string;
  mcpServerPath: string;
}

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
