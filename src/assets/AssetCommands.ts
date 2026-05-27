import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import { formatError } from '../utils/errors';
import { decryptAssetPayload, encryptAssetPayload } from './AssetCrypto';
import { ASSET_PACKAGE_EXTENSION, parseAssetPackageEnvelope } from './AssetPackage';
import { createAssetExportPayload } from './AssetExportService';
import { applyAssetImport, type AssetConflictStrategy } from './AssetImportService';

export interface ExportAssetsCommandOptions {
  configManager: Pick<ConfigManager, 'listServers' | 'getPassword'>;
  extensionName: string;
  extensionVersion: string;
}

export interface ImportAssetsCommandOptions {
  configManager: ConfigManager;
  privateKeyDirectory: string;
  refreshServers(): void;
}

export async function exportAssetsCommand(options: ExportAssetsCommandOptions): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`at-terminal-assets${ASSET_PACKAGE_EXTENSION}`),
    filters: { 'AT Terminal Assets': [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  if (!target) {
    return;
  }

  const picked = await vscode.window.showQuickPick(['Server configuration', 'Passwords', 'Private key files'], {
    canPickMany: true,
    title: 'Choose assets to export'
  });
  if (!picked) {
    return;
  }

  const password = await askForConfirmedPassword('Asset package password');
  if (!password) {
    return;
  }

  try {
    const payload = await createAssetExportPayload({
      servers: await options.configManager.listServers(),
      includePasswords: picked.includes('Passwords'),
      includePrivateKeys: picked.includes('Private key files'),
      extensionName: options.extensionName,
      extensionVersion: options.extensionVersion,
      getPassword: (id) => options.configManager.getPassword(id)
    });
    const envelope = await encryptAssetPayload(payload, password);
    await writeFile(target.fsPath, JSON.stringify(envelope, null, 2), 'utf8');
    await vscode.window.showInformationMessage(`Exported ${payload.servers.length} AT Terminal server assets.`);
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
  }
}

export async function importAssetsCommand(options: ImportAssetsCommandOptions): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { 'AT Terminal Assets': [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  const source = selected?.[0];
  if (!source) {
    return;
  }
  const password = await vscode.window.showInputBox({ prompt: 'Asset package password', password: true });
  if (!password) {
    return;
  }
  const strategyLabel = await vscode.window.showQuickPick(
    ['Skip existing servers', 'Overwrite existing servers', 'Keep both and rename imports'],
    {
      title: 'Choose import conflict handling'
    }
  );
  if (!strategyLabel) {
    return;
  }

  try {
    const envelope = parseAssetPackageEnvelope(JSON.parse(await readFile(source.fsPath, 'utf8')));
    const payload = await decryptAssetPayload(envelope, password);
    await mkdir(options.privateKeyDirectory, { recursive: true });
    const summary = await applyAssetImport({
      payload,
      conflictStrategy: conflictStrategyFromLabel(strategyLabel),
      privateKeyDirectory: options.privateKeyDirectory,
      store: options.configManager,
      generateId: randomUUID
    });
    options.refreshServers();
    await vscode.window.showInformationMessage(
      `Imported ${summary.imported + summary.overwritten + summary.renamed} AT Terminal server assets.`
    );
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
  }
}

export function assetPrivateKeyDirectory(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'imported-private-keys');
}

async function askForConfirmedPassword(prompt: string): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({ prompt, password: true });
  if (!password) {
    return undefined;
  }
  const confirmation = await vscode.window.showInputBox({ prompt: 'Confirm asset package password', password: true });
  return confirmation === password ? password : undefined;
}

function conflictStrategyFromLabel(label: string): AssetConflictStrategy {
  if (label === 'Overwrite existing servers') {
    return 'overwrite';
  }
  if (label === 'Keep both and rename imports') {
    return 'rename';
  }
  return 'skip';
}
