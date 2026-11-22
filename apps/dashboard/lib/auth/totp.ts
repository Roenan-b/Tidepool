/**
 * TOTP (RFC 6238) over HOTP (RFC 4226): HMAC-SHA-1, 30 second steps, 6 digits.
 * Verification accepts the current step plus or minus one, compares in constant time and
 * rejects any step at or before the last accepted step for the user (replay protection).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base32Encode } from './base32.js';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW = 1;
/** 160-bit secrets, the size RFC 4226 recommends for SHA-1. */
export const TOTP_SECRET_BYTES = 20;

export function hotp(secret: Uint8Array, counter: bigint | number, digits = TOTP_DIGITS): string {
  const c = BigInt(counter);
  if (c < 0n) throw new RangeError('counter must be non-negative');
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(c);
  const mac = createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  const mod = 10 ** digits;
  return String(binary % mod).padStart(digits, '0');
}

export function timeStep(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

export function totp(secret: Uint8Array, nowMs: number, digits = TOTP_DIGITS, stepSeconds = TOTP_STEP_SECONDS): string {
  return hotp(secret, timeStep(nowMs, stepSeconds), digits);
}

function constantTimeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still spend a comparison so timing does not depend on where the mismatch is.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export type TotpVerifyResult =
  | { ok: true; step: number }
  | { ok: false; reason: 'format' | 'mismatch' | 'replay' };

/**
 * Verifies a user-entered code. `lastAcceptedStep` is the highest step previously accepted for this
 * user (null if none); any matching step that is not strictly greater is rejected as a replay.
 * All candidate steps are checked so the running time does not reveal which one matched.
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  nowMs: number,
  lastAcceptedStep: number | null,
  window = TOTP_WINDOW,
): TotpVerifyResult {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return { ok: false, reason: 'format' };
  const current = timeStep(nowMs);
  let matched: number | null = null;
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    if (constantTimeEqualStrings(hotp(secret, step), normalized) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (lastAcceptedStep !== null && matched <= lastAcceptedStep) return { ok: false, reason: 'replay' };
  return { ok: true, step: matched };
}

export function generateTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** Key URI understood by common authenticator apps (otpauth://totp/...). */
export function otpauthUri(secret: Uint8Array, accountName: string, issuer = 'Tidepool'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Remembers the last accepted step per user. The in-memory map covers a single dashboard process;
 * when the database has a `totp_last_step` column the repository persists it as well.
 */
export class ReplayGuard {
  private readonly steps = new Map<string, number>();
  constructor(private readonly maxEntries = 1000) {}

  lastStep(userId: string): number | null {
    return this.steps.get(userId) ?? null;
  }

  record(userId: string, step: number): void {
    const prev = this.steps.get(userId);
    if (prev !== undefined && prev >= step) return;
    this.steps.delete(userId);
    this.steps.set(userId, step);
    while (this.steps.size > this.maxEntries) {
      const oldest = this.steps.keys().next().value;
      if (oldest === undefined) break;
      this.steps.delete(oldest);
    }
  }
}
