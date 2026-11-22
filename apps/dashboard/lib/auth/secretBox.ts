/**
 * AES-256-GCM encryption for TOTP secrets at rest.
 * Format: `v1.<ivB64url>.<tagB64url>.<ciphertextB64url>`. The user id is bound as additional
 * authenticated data, so a ciphertext copied onto another user's row fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new RangeError('encryption key must be 32 bytes');
}

export function encryptSecret(plaintext: Uint8Array, key: Buffer, aad: string): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/** Throws if the envelope is malformed, the key is wrong, the AAD differs or the data was altered. */
export function decryptSecret(envelope: string, key: Buffer, aad: string): Buffer {
  assertKey(key);
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported secret envelope');
  const iv = Buffer.from(parts[1]!, 'base64url');
  const tag = Buffer.from(parts[2]!, 'base64url');
  const ct = Buffer.from(parts[3]!, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed secret envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
