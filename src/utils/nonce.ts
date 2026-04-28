import { randomBytes } from 'node:crypto';

export function createNonce(): string {
  return randomBytes(16).toString('base64url');
}
