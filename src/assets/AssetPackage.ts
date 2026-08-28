import { z } from 'zod';
import { migrateServerConfig, serverConfigSchema, type ServerConfig } from '../config/schema';

export const ASSET_PACKAGE_FORMAT = 'at-terminal-assets';
export const ASSET_PACKAGE_VERSION = 1;
export const ASSET_PACKAGE_EXTENSION = '.at-terminal-assets';

/**
 * Thrown when the package decrypted fine (so the password was right) but the
 * payload does not match any shape this version can read. Callers must keep
 * this distinct from the wrong-password error.
 */
export const ASSET_PACKAGE_UNREADABLE_MESSAGE =
  'Asset package payload is from an unsupported or older format.';

const base64Schema = z.string().min(1);

export const assetPackageEnvelopeSchema = z
  .object({
    format: z.literal(ASSET_PACKAGE_FORMAT),
    version: z.literal(ASSET_PACKAGE_VERSION),
    kdf: z.literal('scrypt'),
    cipher: z.literal('aes-256-gcm'),
    salt: base64Schema,
    iv: base64Schema,
    authTag: base64Schema,
    ciphertext: base64Schema
  })
  .strict();

export const assetPackagePayloadSchema = z
  .object({
    format: z.literal(ASSET_PACKAGE_FORMAT),
    version: z.literal(ASSET_PACKAGE_VERSION),
    createdAt: z.number().int().nonnegative(),
    source: z
      .object({
        extensionName: z.string().min(1),
        extensionVersion: z.string().min(1)
      })
      .strict(),
    options: z
      .object({
        includesPasswords: z.boolean(),
        includesPrivateKeys: z.boolean(),
        includesHostTrust: z.literal(false)
      })
      .strict(),
    servers: z.array(serverConfigSchema),
    passwords: z.record(z.string().min(1), z.string()),
    privateKeys: z.array(
      z
        .object({
          serverId: z.string().min(1),
          originalBasename: z.string().min(1),
          contentBase64: base64Schema
        })
        .strict()
    ),
    omissions: z.array(
      z
        .object({
          serverId: z.string().min(1),
          kind: z.enum(['password', 'privateKey']),
          reason: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

export type AssetPackageEnvelope = z.infer<typeof assetPackageEnvelopeSchema>;
export type AssetPackagePayload = z.infer<typeof assetPackagePayloadSchema>;
export type AssetPackageOmission = AssetPackagePayload['omissions'][number];
export type AssetPrivateKeyRecord = AssetPackagePayload['privateKeys'][number];

export function parseAssetPackageEnvelope(value: unknown): AssetPackageEnvelope {
  return assetPackageEnvelopeSchema.parse(value);
}

export function parseAssetPackagePayload(value: unknown): AssetPackagePayload {
  return assetPackagePayloadSchema.parse(migratePayloadServers(value));
}

/**
 * Packages exported by 0.3.x hold servers saved before `encoding` existed or
 * with keys this version dropped. Each entry is migrated to the canonical
 * shape before the strict payload parse; entries that cannot be migrated are
 * skipped instead of failing the whole package.
 */
function migratePayloadServers(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.servers)) {
    return value;
  }
  return {
    ...record,
    servers: record.servers
      .map((server) => migrateServerConfig(server))
      .filter((server): server is ServerConfig => server !== undefined)
  };
}
