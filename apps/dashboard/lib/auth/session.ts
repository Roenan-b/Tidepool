/**
 * Session tokens and the short-lived pre-2FA "pending" ticket.
 *
 * - Session: 32 random bytes, base64url, in an HttpOnly SameSite=Strict cookie. Only sha256(token)
 *   is stored in auth_sessions, so a database leak does not yield usable cookies.
 * - Pending: after a correct password for a TOTP-enrolled user, the browser receives an HMAC-signed
 *   ticket naming the user and an expiry. It is not a session: no auth_sessions row exists and every
 *   guard rejects it. Only the TOTP step accepts it.
 */
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_BYTES = 32;
export const PENDING_TTL_MS = 5 * 60 * 1000;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Rejects anything that is not a token this module could have produced, before touching the database. */
export function isWellFormedToken(token: string | undefined | null): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function cookieNames(secure: boolean): { session: string; pending: string } {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure, Path=/ and host-only.
  return secure
    ? { session: '__Host-tp_session', pending: '__Host-tp_pending' }
    : { session: 'tp_session', pending: 'tp_pending' };
}

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: '/';
  maxAge: number;
}

export function cookieOptions(secure: boolean, maxAgeSeconds: number): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

function pendingKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'tidepool pending login v1', 32));
}

export function signPendingTicket(userId: string, nowMs: number, masterKey: Buffer): string {
  const exp = nowMs + PENDING_TTL_MS;
  const nonce = randomBytes(12).toString('base64url');
  const body = `${userId}.${exp}.${nonce}`;
  const mac = createHmac('sha256', pendingKey(masterKey)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyPendingTicket(
  ticket: string | undefined | null,
  nowMs: number,
  masterKey: Buffer,
): { userId: string } | null {
  if (typeof ticket !== 'string' || ticket.length > 256) return null;
  const parts = ticket.split('.');
  if (parts.length !== 4) return null;
  const [userId, expRaw, nonce, mac] = parts as [string, string, string, string];
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d{1,15}$/.test(expRaw) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
  const expected = createHmac('sha256', pendingKey(masterKey)).update(`${userId}.${expRaw}.${nonce}`).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const exp = Number(expRaw);
  if (exp <= nowMs || exp - nowMs > PENDING_TTL_MS) return null;
  return { userId };
}
