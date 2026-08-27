import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hubJsPath, hubVersionPath, syncHubBundle } from '@at-series/mcp-hub';
import * as vscode from 'vscode';

const require = createRequire(__filename);

export interface HubSyncOptions {
  /** Repair: always run the full hash-based election, even when the fast path matches. */
  force?: boolean;
  /** Where the fast-path state is persisted. Omitting it disables the fast path. */
  statePath?: string;
}

/**
 * What the last full sync observed. The fast path may skip re-hashing the bundle only
 * while every field still matches: our packaged hub version, the elected version in
 * `hub-version.json`, and the size/mtime of the active `hub.js` on disk.
 */
interface HubSyncState {
  hubVersion: string;
  activeVersion: string;
  targetSize: number;
  targetMtimeMs: number;
}

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
  home?: string,
  options: HubSyncOptions = {}
): Promise<{ updated: boolean; activeVersion: string }> {
  await access(bundlePath);
  if (!options.force && options.statePath) {
    const skipped = await tryFastPathSkip(options.statePath, versions.hubVersion, home);
    if (skipped) {
      return skipped;
    }
  }
  const result = await syncHubBundle({
    version: versions.hubVersion,
    bundlePath,
    pluginId: 'at.terminal',
    pluginVersion: versions.pluginVersion,
    home
  });
  if (options.statePath) {
    await writeFastPathState(options.statePath, versions.hubVersion, result.activeVersion, home);
  }
  return result;
}

export async function syncPackagedHub(
  context: vscode.ExtensionContext,
  options: { force?: boolean } = {}
): Promise<{ updated: boolean; activeVersion: string }> {
  const bundlePath = vscode.Uri.joinPath(context.extensionUri, 'dist', 'hub.js').fsPath;
  const hubVersion = await resolveHubPackageVersion(bundlePath);
  return syncPackagedHubAt(
    bundlePath,
    {
      hubVersion,
      pluginVersion: String(context.extension.packageJSON.version)
    },
    undefined,
    {
      force: options.force,
      statePath: join(context.globalStorageUri.fsPath, 'hub-sync-state.json')
    }
  );
}

/**
 * Activation-time fast path: when `hub-version.json` still names the version the last
 * sync elected and the active `hub.js` has the exact size and mtime recorded then, the
 * full sha256 read of both bundles is skipped. Any mismatch — or a Repair with `force`
 * — falls back to `syncHubBundle`, which hashes and heals as before.
 */
async function tryFastPathSkip(
  statePath: string,
  hubVersion: string,
  home: string | undefined
): Promise<{ updated: false; activeVersion: string } | undefined> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Partial<HubSyncState>;
    if (
      state.hubVersion !== hubVersion ||
      typeof state.activeVersion !== 'string' ||
      typeof state.targetSize !== 'number' ||
      typeof state.targetMtimeMs !== 'number'
    ) {
      return undefined;
    }
    const resolvedHome = home ?? homedir();
    const meta = JSON.parse(await readFile(hubVersionPath(resolvedHome), 'utf8')) as { version?: unknown };
    if (meta.version !== state.activeVersion) {
      return undefined;
    }
    const target = await stat(hubJsPath(resolvedHome));
    if (target.size !== state.targetSize || target.mtimeMs !== state.targetMtimeMs) {
      return undefined;
    }
    return { updated: false, activeVersion: state.activeVersion };
  } catch {
    return undefined;
  }
}

async function writeFastPathState(
  statePath: string,
  hubVersion: string,
  activeVersion: string,
  home: string | undefined
): Promise<void> {
  try {
    const target = await stat(hubJsPath(home ?? homedir()));
    const state: HubSyncState = {
      hubVersion,
      activeVersion,
      targetSize: target.size,
      targetMtimeMs: target.mtimeMs
    };
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state), 'utf8');
  } catch {
    // Best-effort: the fast path is an optimization, never a correctness dependency.
  }
}
