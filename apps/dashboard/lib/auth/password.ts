/**
 * Password hashing with scrypt (node:crypto). Stored format: `scrypt$N$r$p$saltB64$hashB64`.
 * Parameters are stored with each hash so they can be raised later without breaking old hashes.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** N = 2^16, r = 8, p = 1: about 64 MiB per hash. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 65536, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
/** Upper bounds when parsing stored hashes, so a corrupted row cannot request unbounded memory. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

function scrypt(password: string, salt: Buffer, keylen: number, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * params.p + 32 * 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function validParams(p: ScryptParams): boolean {
  return (
    Number.isInteger(p.N) &&
    p.N >= 2 &&
    p.N <= MAX_N &&
    (p.N & (p.N - 1)) === 0 &&
    Number.isInteger(p.r) &&
    p.r >= 1 &&
    p.r <= MAX_R &&
    Number.isInteger(p.p) &&
    p.p >= 1 &&
    p.p <= MAX_P
  );
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  if (!validParams(params)) throw new RangeError('invalid scrypt parameters');
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) throw new RangeError('invalid password length');
  const salt = randomBytes(SALT_BYTES);
  const hash = await scrypt(password, salt, KEY_LENGTH, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function parsePasswordHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  if (![n, r, p].every((v) => /^\d{1,8}$/.test(v))) return null;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (!validParams(params)) return null;
  const salt = Buffer.from(saltB64, 'base64');
  const hash = Buffer.from(hashB64, 'base64');
  if (salt.length < 16 || hash.length < 16 || hash.length > 64) return null;
  return { params, salt, hash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length === 0 || password.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const candidate = await scrypt(password, parsed.salt, parsed.hash.length, parsed.params);
  return timingSafeEqual(candidate, parsed.hash);
}

/**
 * A fixed hash used to spend the same work when a username does not exist, so response timing
 * does not reveal which usernames are registered. Generated lazily once per process.
 */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('tidepool-timing-equalizer');
  await verifyPassword(password.slice(0, PASSWORD_MAX_LENGTH) || 'x', await dummyHash);
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (password.trim() !== password) return 'Password must not start or end with whitespace';
  return null;
}
