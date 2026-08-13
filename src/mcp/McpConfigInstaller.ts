import {
  detectHostApp,
  ensureAtSeriesMcpConfig,
  hubJsPath,
  uninstallAtSeriesMcpConfig,
  type HostApp,
  type McpInstallerTarget
} from '@at-series/mcp-hub';

export interface AtSeriesIdeMcpConfigOptions {
  appName?: string;
  appRoot?: string;
  uriScheme?: string;
  extensionPath?: string;
  workspaceFolder?: string;
  home?: string;
  hubJsAbsolutePath?: string;
}

/**
 * Map host app to MCP installer target.
 * VS Code / unknown / other hosts are skipped (old installer did not write for them).
 */
export function resolveMcpInstallerTarget(
  hostApp: HostApp,
  workspaceFolder?: string
): McpInstallerTarget | undefined {
  if (hostApp === 'kiro') {
    return 'kiro';
  }
  if (hostApp === 'continue') {
    return workspaceFolder ? 'continue' : undefined;
  }
  if (hostApp === 'cursor') {
    return 'cursor';
  }
  return undefined;
}

/** Ensure shared AT Series MCP entry via Hub installer (meta-only autoApprove). */
export async function ensureAtSeriesConfigForCurrentIde(
  options: AtSeriesIdeMcpConfigOptions
): Promise<{ updated: boolean } | undefined> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) {
    return undefined;
  }
  return ensureAtSeriesMcpConfig({
    target,
    hostApp,
    hubJsAbsolutePath: options.hubJsAbsolutePath ?? hubJsPath(options.home),
    home: options.home,
    workspaceFolder: options.workspaceFolder
  });
}

export async function uninstallAtSeriesConfigForCurrentIde(
  options: AtSeriesIdeMcpConfigOptions
): Promise<{ removed: boolean } | undefined> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) {
    return undefined;
  }
  return uninstallAtSeriesMcpConfig({
    target,
    home: options.home,
    workspaceFolder: options.workspaceFolder
  });
}
