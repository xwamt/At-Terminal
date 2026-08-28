import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConfigManager } from '../config/ConfigManager';
import { formatError } from '../utils/errors';
import { decryptAssetPayload, encryptAssetPayload } from './AssetCrypto';
import {
  ASSET_PACKAGE_EXTENSION,
  ASSET_PACKAGE_UNREADABLE_MESSAGE,
  parseAssetPackageEnvelope
} from './AssetPackage';
import { createAssetExportPayload } from './AssetExportService';
import { applyAssetImport, type AssetConflictStrategy } from './AssetImportService';
import { t } from '../i18n/t';

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
    filters: { [t('AT Terminal Assets')]: [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  if (!target) {
    return;
  }

  const serverConfigLabel = t('Server configuration');
  const passwordsLabel = t('Passwords');
  const privateKeysLabel = t('Private key files');
  const picked = await vscode.window.showQuickPick([serverConfigLabel, passwordsLabel, privateKeysLabel], {
    canPickMany: true,
    title: t('Choose assets to export')
  });
  if (!picked) {
    return;
  }

  const password = await askForConfirmedPassword(t('Asset package password'));
  if (!password) {
    return;
  }

  try {
    const payload = await createAssetExportPayload({
      servers: await options.configManager.listServers(),
      includePasswords: picked.includes(passwordsLabel),
      includePrivateKeys: picked.includes(privateKeysLabel),
      extensionName: options.extensionName,
      extensionVersion: options.extensionVersion,
      getPassword: (id) => options.configManager.getPassword(id)
    });
    const envelope = await encryptAssetPayload(payload, password);
    await writeFile(target.fsPath, JSON.stringify(envelope, null, 2), 'utf8');
    await vscode.window.showInformationMessage(
      t('Exported {count} AT Terminal server assets.', { count: payload.servers.length })
    );
  } catch (error) {
    await vscode.window.showErrorMessage(formatError(error));
  }
}

export async function importAssetsCommand(options: ImportAssetsCommandOptions): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { [t('AT Terminal Assets')]: [ASSET_PACKAGE_EXTENSION.slice(1)] }
  });
  const source = selected?.[0];
  if (!source) {
    return;
  }

  let envelope;
  try {
    envelope = parseAssetPackageEnvelope(JSON.parse(await readFile(source.fsPath, 'utf8')));
  } catch (error) {
    await vscode.window.showErrorMessage(localizeAssetImportError(error));
    return;
  }

  // A wrong package password is recoverable, so keep asking instead of silently exiting.
  let payload;
  for (;;) {
    const password = await vscode.window.showInputBox({ prompt: t('Asset package password'), password: true });
    if (!password) {
      return;
    }
    try {
      payload = await decryptAssetPayload(envelope, password);
      break;
    } catch (error) {
      const retryAction = t('Try Again');
      const choice = await vscode.window.showErrorMessage(localizeAssetImportError(error), retryAction);
      if (choice !== retryAction) {
        return;
      }
    }
  }

  const skipLabel = t('Skip existing servers');
  const overwriteLabel = t('Overwrite existing servers');
  const renameLabel = t('Keep both and rename imports');
  const strategyLabel = await vscode.window.showQuickPick(
    [skipLabel, overwriteLabel, renameLabel],
    {
      title: t('Choose import conflict handling')
    }
  );
  if (!strategyLabel) {
    return;
  }

  try {
    await mkdir(options.privateKeyDirectory, { recursive: true });
    const summary = await applyAssetImport({
      payload,
      conflictStrategy: conflictStrategyFromLabel(strategyLabel, { overwriteLabel, renameLabel }),
      privateKeyDirectory: options.privateKeyDirectory,
      store: options.configManager,
      generateId: randomUUID
    });
    options.refreshServers();
    await vscode.window.showInformationMessage(
      t('Imported {count} AT Terminal server assets.', {
        count: summary.imported + summary.overwritten + summary.renamed
      })
    );
  } catch (error) {
    await vscode.window.showErrorMessage(localizeAssetImportError(error));
  }
}

/**
 * AssetCrypto and the envelope parser throw English messages; the command layer maps
 * the known recoverable case (wrong password / corrupted package) to a localized
 * message and wraps everything else so the user still sees a translated frame.
 * An unreadable payload after a successful decrypt is a distinct case: the
 * password was right, so telling the user to retype it would be misleading.
 */
export function localizeAssetImportError(error: unknown): string {
  const message = formatError(error);
  if (message.includes('Invalid package password or corrupted asset package')) {
    return t('Import failed: the package password is wrong or the package file is corrupted.');
  }
  if (message.includes(ASSET_PACKAGE_UNREADABLE_MESSAGE)) {
    return t('Import failed: the asset package is from an older format and could not be read.');
  }
  return t('Import failed: {message}', { message });
}

export function assetPrivateKeyDirectory(context: vscode.ExtensionContext): string {
  return join(context.globalStorageUri.fsPath, 'imported-private-keys');
}

async function askForConfirmedPassword(prompt: string): Promise<string | undefined> {
  for (;;) {
    const password = await vscode.window.showInputBox({ prompt, password: true });
    if (!password) {
      return undefined;
    }
    const confirmation = await vscode.window.showInputBox({
      prompt: t('Confirm asset package password'),
      password: true
    });
    if (confirmation === password) {
      return password;
    }
    // A typo used to abort the whole export silently; surface it and offer a redo.
    const retryAction = t('Try Again');
    const choice = await vscode.window.showErrorMessage(t('The passwords do not match.'), retryAction);
    if (choice !== retryAction) {
      return undefined;
    }
  }
}

function conflictStrategyFromLabel(
  label: string,
  labels: { overwriteLabel: string; renameLabel: string }
): AssetConflictStrategy {
  if (label === labels.overwriteLabel) {
    return 'overwrite';
  }
  if (label === labels.renameLabel) {
    return 'rename';
  }
  return 'skip';
}

