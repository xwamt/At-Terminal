import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { syncHubBundle } from '@at-series/mcp-hub';
import * as vscode from 'vscode';

const require = createRequire(__filename);

async function resolveHubPackageVersion(bundlePath: string): Promise<string> {
  const sidecar = join(dirname(bundlePath), 'hub-version.json');
  try {
    const raw = await readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to node_modules resolution (dev / file: link).
  }

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
  await access(bundlePath);
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
  const hubVersion = await resolveHubPackageVersion(bundlePath);
  return syncPackagedHubAt(bundlePath, {
    hubVersion,
    pluginVersion: String(context.extension.packageJSON.version)
  });
}
