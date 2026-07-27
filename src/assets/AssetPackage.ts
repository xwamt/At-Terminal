import { z } from 'zod';
import { serverConfigSchema } from '../config/schema';

export const ASSET_PACKAGE_FORMAT = 'at-terminal-assets';
export const ASSET_PACKAGE_VERSION = 1;
export const ASSET_PACKAGE_EXTENSION = '.at-terminal-assets';

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
  return assetPackagePayloadSchema.parse(value);
}
