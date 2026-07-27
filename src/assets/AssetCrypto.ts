import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import {
  ASSET_PACKAGE_FORMAT,
  ASSET_PACKAGE_VERSION,
  parseAssetPackageEnvelope,
  parseAssetPackagePayload,
  type AssetPackageEnvelope,
  type AssetPackagePayload
} from './AssetPackage';

const scrypt = promisify(scryptCallback);
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export async function encryptAssetPayload(
  payload: AssetPackagePayload,
  packagePassword: string
): Promise<AssetPackageEnvelope> {
  const parsed = parseAssetPackagePayload(payload);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = (await scrypt(packagePassword, salt, KEY_BYTES)) as Buffer;
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(parsed), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    format: ASSET_PACKAGE_FORMAT,
    version: ASSET_PACKAGE_VERSION,
    kdf: 'scrypt',
    cipher: 'aes-256-gcm',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

export async function decryptAssetPayload(
  envelope: AssetPackageEnvelope,
  packagePassword: string
): Promise<AssetPackagePayload> {
  const parsedEnvelope = parseAssetPackageEnvelope(envelope);
  try {
    const salt = Buffer.from(parsedEnvelope.salt, 'base64');
    const iv = Buffer.from(parsedEnvelope.iv, 'base64');
    const authTag = Buffer.from(parsedEnvelope.authTag, 'base64');
    const ciphertext = Buffer.from(parsedEnvelope.ciphertext, 'base64');
    const key = (await scrypt(packagePassword, salt, KEY_BYTES)) as Buffer;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return parseAssetPackagePayload(JSON.parse(plaintext));
  } catch {
    throw new Error('Invalid package password or corrupted asset package.');
  }
}
