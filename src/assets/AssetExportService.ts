import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ServerConfig } from '../config/schema';
import { ASSET_PACKAGE_FORMAT, ASSET_PACKAGE_VERSION, type AssetPackagePayload } from './AssetPackage';

export interface AssetExportOptions {
  servers: ServerConfig[];
  includePasswords: boolean;
  includePrivateKeys: boolean;
  extensionName: string;
  extensionVersion: string;
  getPassword(id: string): Promise<string | undefined>;
  now?: () => number;
}

export async function createAssetExportPayload(options: AssetExportOptions): Promise<AssetPackagePayload> {
  const passwords: Record<string, string> = {};
  const privateKeys: AssetPackagePayload['privateKeys'] = [];
  const omissions: AssetPackagePayload['omissions'] = [];

  for (const server of options.servers) {
    if (options.includePasswords && server.authType === 'password') {
      const password = await options.getPassword(server.id);
      if (password) {
        passwords[server.id] = password;
      } else {
        omissions.push({ serverId: server.id, kind: 'password', reason: 'Password was not available in SecretStorage.' });
      }
    }

    if (options.includePrivateKeys && server.authType === 'privateKey' && server.privateKeyPath) {
      try {
        const content = await readFile(server.privateKeyPath);
        privateKeys.push({
          serverId: server.id,
          originalBasename: basename(server.privateKeyPath),
          contentBase64: content.toString('base64')
        });
      } catch {
        omissions.push({ serverId: server.id, kind: 'privateKey', reason: 'Private key file could not be read.' });
      }
    }
  }

  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    createdAt: options.now?.() ?? Date.now(),
    source: { extensionName: options.extensionName, extensionVersion: options.extensionVersion },
    options: {
      includesPasswords: options.includePasswords,
      includesPrivateKeys: options.includePrivateKeys,
      includesHostTrust: false
    },
    servers: options.servers,
    passwords,
    privateKeys,
    omissions
  };
}
