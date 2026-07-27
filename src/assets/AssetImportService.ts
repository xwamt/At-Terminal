import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerConfig } from '../config/schema';
import type { AssetPackagePayload } from './AssetPackage';

export type AssetConflictStrategy = 'skip' | 'overwrite' | 'rename';

export interface ImportedServerStore {
  listServers(): Promise<ServerConfig[]>;
  saveServer(server: ServerConfig, password?: string): Promise<void>;
}

export interface AssetImportOptions {
  payload: AssetPackagePayload;
  conflictStrategy: AssetConflictStrategy;
  privateKeyDirectory: string;
  store: ImportedServerStore;
  generateId(): string;
}

export interface AssetImportSummary {
  imported: number;
  skipped: number;
  overwritten: number;
  renamed: number;
  privateKeysWritten: number;
}

export async function applyAssetImport(options: AssetImportOptions): Promise<AssetImportSummary> {
  const existing = await options.store.listServers();
  const summary: AssetImportSummary = { imported: 0, skipped: 0, overwritten: 0, renamed: 0, privateKeysWritten: 0 };
  const idMap = new Map<string, string>();
  const privateKeys = new Map(options.payload.privateKeys.map((entry) => [entry.serverId, entry]));
  const planned: Array<{
    server: ServerConfig;
    password?: string;
    privateKeyContent?: Buffer;
    privateKeyBasename?: string;
  }> = [];

  for (const imported of options.payload.servers) {
    const conflict = findConflict(imported, existing);
    if (conflict && options.conflictStrategy === 'skip') {
      summary.skipped += 1;
      idMap.set(imported.id, conflict.id);
      continue;
    }

    let server = { ...imported };
    if (conflict && options.conflictStrategy === 'overwrite') {
      server.id = conflict.id;
      summary.overwritten += 1;
    } else if (conflict && options.conflictStrategy === 'rename') {
      server = { ...server, id: options.generateId(), label: `${server.label} (imported)` };
      summary.renamed += 1;
    } else {
      summary.imported += 1;
    }
    idMap.set(imported.id, server.id);

    const keyRecord = privateKeys.get(imported.id);
    planned.push({
      server,
      password: options.payload.passwords[imported.id],
      privateKeyContent: keyRecord ? Buffer.from(keyRecord.contentBase64, 'base64') : undefined,
      privateKeyBasename: keyRecord?.originalBasename
    });
  }

  await mkdir(options.privateKeyDirectory, { recursive: true });

  for (const item of planned) {
    const remappedJumpHostId = item.server.jumpHostId ? idMap.get(item.server.jumpHostId) ?? item.server.jumpHostId : undefined;
    let server = { ...item.server, jumpHostId: remappedJumpHostId };
    if (item.privateKeyContent && item.privateKeyBasename) {
      const privateKeyPath = join(options.privateKeyDirectory, safePrivateKeyName(server.id, item.privateKeyBasename));
      await writeFile(privateKeyPath, item.privateKeyContent, { mode: 0o600 });
      server = { ...server, privateKeyPath };
      summary.privateKeysWritten += 1;
    }
    await options.store.saveServer(server, item.password);
  }

  return summary;
}

function findConflict(imported: ServerConfig, existing: ServerConfig[]): ServerConfig | undefined {
  return (
    existing.find((server) => server.id === imported.id) ??
    existing.find(
      (server) =>
        normalize(server.label) === normalize(imported.label) &&
        normalize(server.host) === normalize(imported.host) &&
        server.port === imported.port &&
        normalize(server.username) === normalize(imported.username)
    )
  );
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function safePrivateKeyName(serverId: string, basename: string): string {
  const safeBase = basename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${serverId}-${safeBase}`;
}
