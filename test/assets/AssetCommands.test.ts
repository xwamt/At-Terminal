import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { exportAssetsCommand, importAssetsCommand } from '../../src/assets/AssetCommands';
import { encryptAssetPayload } from '../../src/assets/AssetCrypto';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION } from '../../src/assets/AssetPackage';
import type { ConfigManager } from '../../src/config/ConfigManager';
import type { ServerConfig } from '../../src/config/schema';

function server(): ServerConfig {
  return {
    id: 'server-1',
    label: 'Prod',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    keepAliveInterval: 30,
    encoding: 'utf-8',
    createdAt: 1,
    updatedAt: 1
  };
}

describe('AssetCommands', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'at-commands-'));
    (vscode.window as any).__resetDialogs();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports encrypted assets to the selected file', async () => {
    const output = join(dir, 'assets.at-terminal-assets');
    (vscode.window as any).__setSaveDialogResult(output);
    (vscode.window as any).__setQuickPickResults([['Server configuration', 'Passwords']]);
    (vscode.window as any).__setInputBoxResults(['package-pass', 'package-pass']);
    const configManager = {
      listServers: async () => [server()],
      getPassword: async () => 'secret'
    } as Pick<ConfigManager, 'listServers' | 'getPassword'>;

    await exportAssetsCommand({ configManager, extensionName: 'at-terminal', extensionVersion: '2.10.2' });

    const raw = await readFile(output, 'utf8');
    expect(raw).toContain('"format"');
    expect(raw).not.toContain('secret');
  });

  it('imports assets and refreshes the server tree', async () => {
    const input = join(dir, 'assets.at-terminal-assets');
    const envelope = await encryptAssetPayload(
      {
        format: ASSET_PACKAGE_FORMAT,
        version: ASSET_PACKAGE_VERSION,
        createdAt: 1,
        source: { extensionName: 'at-terminal', extensionVersion: '2.10.2' },
        options: { includesPasswords: true, includesPrivateKeys: false, includesHostTrust: false },
        servers: [server()],
        passwords: { 'server-1': 'secret' },
        privateKeys: [],
        omissions: []
      },
      'package-pass'
    );
    await writeFile(input, JSON.stringify(envelope), 'utf8');
    (vscode.window as any).__setOpenDialogResult(input);
    (vscode.window as any).__setInputBoxResults(['package-pass']);
    (vscode.window as any).__setQuickPickResults(['Skip existing servers']);
    const saveServer = vi.fn();

    await importAssetsCommand({
      configManager: { listServers: async () => [], saveServer } as unknown as ConfigManager,
      privateKeyDirectory: join(dir, 'keys'),
      refreshServers: vi.fn()
    });

    expect(saveServer).toHaveBeenCalledWith(expect.objectContaining({ id: 'server-1' }), 'secret');
  });
});
