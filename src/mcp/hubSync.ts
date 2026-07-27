import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { syncHubBundle } from '@at-series/mcp-hub';
import * as vscode from 'vscode';

const require = createRequire(__filename);

function resolveHubPackageVersion(): string {
  try {
    return require('@at-series/mcp-hub/package.json').version as string;
  } catch {
    const hubEntry = require.resolve('@at-series/mcp-hub/hub');
    const pkgPath = join(dirname(hubEntry), '..', 'package.json');
    return require(pkgPath).version as string;
  }
}

export async function syncPackagedHubAt(
  bundlePath: string,
  versions: { hubVersion: string; pluginVersion: string },
  home?: string
): Promise<{ updated: boolean; activeVersion: string }> {
  return syncHubBundle({
    version: versions.hubVersion,
    bundlePath,
    pluginId: 'at.terminal',
    pluginVersion: versions.pluginVersion,
    home
  });
}

export async function syncPackagedHub(
  context: vscode.ExtensionContext
): Promise<{ updated: boolean; activeVersion: string }> {
  const bundlePath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'hub.js').fsPath;
  return syncPackagedHubAt(bundlePath, {
    hubVersion: resolveHubPackageVersion(),
    pluginVersion: String(context.extension.packageJSON.version)
  });
}
