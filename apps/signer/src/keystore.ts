import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { base58Decode } from './base58.js';

/**
 * Encrypted keystore for the hot wallet.
 *
 * Format (JSON, version 1):
 *   { version, publicKey, kdf: { name: 'scrypt', N, r, p, dkLen, salt }, cipher: { name: 'aes-256-gcm', iv, tag, ciphertext } }
 * Binary fields are base64. The 64-byte Solana secret key is encrypted with AES-256-GCM under a key
 * derived from the passphrase with scrypt. Every header field (version, public key, KDF parameters,
 * cipher name) is bound as GCM additional authenticated data, so editing the header is detected the
 * same way as editing the ciphertext.
 */

export const MIN_PASSPHRASE_LENGTH = 12;
export const DEFAULT_SCRYPT_N = 1 << 17; // about 128 MiB with r = 8
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_KEY_LEN = 64;

const b64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(512);

const KeystoreSchema = z.object({
  version: z.literal(1),
  publicKey: z.string().min(32).max(44),
  kdf: z.object({
    name: z.literal('scrypt'),
    // Bounded so a crafted file cannot force huge memory or CPU use at load time.
    N: z.number().int().refine((n) => n >= 1 << 14 && n <= 1 << 20 && (n & (n - 1)) === 0, 'N must be a power of two in [2^14, 2^20]'),
    r: z.number().int().min(8).max(16),
    p: z.number().int().min(1).max(4),
    dkLen: z.literal(KEY_LEN),
    salt: b64,
  }).strict(),
  cipher: z.object({
    name: z.literal('aes-256-gcm'),
    iv: b64,
    tag: b64,
    ciphertext: b64,
  }).strict(),
}).strict();

export type KeystoreFile = z.infer<typeof KeystoreSchema>;

export interface CreateKeystoreOptions {
  /** scrypt cost. Production keystores use the default; tests may lower it (minimum 2^14). */
  scryptN?: number;
}

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

function aad(ks: Pick<KeystoreFile, 'version' | 'publicKey' | 'kdf' | 'cipher'>): Buffer {
  return Buffer.from(JSON.stringify([ks.version, ks.publicKey, ks.kdf.name, ks.kdf.N, ks.kdf.r, ks.kdf.p, ks.kdf.dkLen, ks.kdf.salt, ks.cipher.name]), 'utf8');
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r * p + 64 * 1024 * 1024 });
}

/** Encrypts a 64-byte Solana secret key. The caller owns `secretKeyBytes` and should zero it afterwards. */
export function createKeystore(secretKeyBytes: Uint8Array, passphrase: string, options: CreateKeystoreOptions = {}): KeystoreFile {
  assertPassphrase(passphrase);
  if (!(secretKeyBytes instanceof Uint8Array) || secretKeyBytes.length !== SECRET_KEY_LEN) {
    throw new Error('secret key must be 64 bytes');
  }
  // Validates that the public half matches the private half before anything is written.
  const publicKey = Keypair.fromSecretKey(Uint8Array.from(secretKeyBytes)).publicKey.toBase58();
  const N = options.scryptN ?? DEFAULT_SCRYPT_N;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const header = {
    version: 1 as const,
    publicKey,
    kdf: { name: 'scrypt' as const, N, r: SCRYPT_R, p: SCRYPT_P, dkLen: KEY_LEN as 32, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm' as const, iv: '', tag: '', ciphertext: '' },
  };
  const key = deriveKey(passphrase, salt, N, SCRYPT_R, SCRYPT_P);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    cipher.setAAD(aad(header));
    const ciphertext = Buffer.concat([cipher.update(secretKeyBytes), cipher.final()]);
    const ks: KeystoreFile = {
      ...header,
      cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
    };
    return KeystoreSchema.parse(ks);
  } finally {
    key.fill(0);
  }
}

/** Parses and validates keystore JSON text. Throws on any structural problem. */
export function parseKeystore(text: string): KeystoreFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('keystore is not valid JSON');
  }
  const parsed = KeystoreSchema.safeParse(raw);
  if (!parsed.success) throw new Error('keystore has an invalid format');
  return parsed.data;
}

/**
 * Decrypts a keystore and returns the Keypair. A wrong passphrase and a tampered file produce the
 * same generic error so the failure does not tell an attacker which part was wrong.
 */
export function decryptKeystore(ks: KeystoreFile, passphrase: string): Keypair {
  assertPassphrase(passphrase);
  const salt = Buffer.from(ks.kdf.salt, 'base64');
  const iv = Buffer.from(ks.cipher.iv, 'base64');
  const tag = Buffer.from(ks.cipher.tag, 'base64');
  const ciphertext = Buffer.from(ks.cipher.ciphertext, 'base64');
  if (salt.length < 16 || iv.length !== IV_LEN || tag.length !== TAG_LEN || ciphertext.length !== SECRET_KEY_LEN) {
    throw new Error('keystore has an invalid format');
  }
  const key = deriveKey(passphrase, salt, ks.kdf.N, ks.kdf.r, ks.kdf.p);
  let plain: Buffer | null = null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
    decipher.setAAD(aad(ks));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('unable to decrypt keystore (wrong passphrase or corrupted file)');
  } finally {
    key.fill(0);
  }
  try {
    // Keypair keeps a reference to the array it is given, so hand it a copy and zero our buffer.
    const keypair = Keypair.fromSecretKey(Uint8Array.from(plain));
    if (!keypair.publicKey.equals(new PublicKey(ks.publicKey))) {
      throw new Error('mismatch');
    }
    return keypair;
  } catch {
    throw new Error('unable to decrypt keystore (wrong passphrase or corrupted file)');
  } finally {
    plain.fill(0);
  }
}

/** Throws if the file grants any permission to group or other (POSIX only). */
export function assertPrivateFile(path: string, label: string): void {
  if (process.platform === 'win32') return;
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`${label} is not a regular file`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${label} permissions are too open (${(st.mode & 0o777).toString(8)}); run: chmod 600 ${path}`);
  }
}

export function loadKeystore(path: string, passphrase: string): Keypair {
  assertPassphrase(passphrase);
  assertPrivateFile(path, 'keystore file');
  return decryptKeystore(parseKeystore(readFileSync(path, 'utf8')), passphrase);
}

/** Reads only the public key from a keystore (no passphrase needed). */
export function readKeystorePublicKey(path: string): string {
  const ks = parseKeystore(readFileSync(path, 'utf8'));
  return new PublicKey(ks.publicKey).toBase58();
}

/**
 * Writes a keystore with mode 0600. Refuses to overwrite an existing file so a live key cannot be
 * replaced by accident.
 */
export function writeKeystoreFile(path: string, ks: KeystoreFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, JSON.stringify(ks, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

/**
 * Parses an exported secret key given as base58 text or as a JSON array of 64 byte values
 * (the format written by the Solana CLI). Returns a fresh 64-byte array the caller must zero.
 */
export function parseSecretKeyText(text: string): Uint8Array {
  const trimmed = text.trim();
  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error('secret key JSON is malformed');
    }
    if (!Array.isArray(arr) || arr.length !== SECRET_KEY_LEN || !arr.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
      throw new Error('secret key JSON must be an array of 64 byte values');
    }
    bytes = Uint8Array.from(arr as number[]);
    arr.fill(0);
  } else {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) throw new Error('secret key must be base58 or a JSON byte array');
    bytes = base58Decode(trimmed);
  }
  if (bytes.length !== SECRET_KEY_LEN) {
    bytes.fill(0);
    throw new Error('secret key must decode to 64 bytes');
  }
  return bytes;
}
