import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PENDING_TTL_MS,
  cookieNames,
  cookieOptions,
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
  signPendingTicket,
  verifyPendingTicket,
} from './session.js';

const key = randomBytes(32);
const userId = '3f2b8c1e-8d4a-4b6f-9a0e-2c1d5e7f9a1b';

describe('session tokens', () => {
  it('are 32 random bytes in base64url and unique', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(isWellFormedToken(a)).toBe(true);
  });

  it('are stored only as sha256 hex', () => {
    const t = generateSessionToken();
    const h = hashSessionToken(t);
    expect(h).toBe(createHash('sha256').update(t).digest('hex'));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
  });

  it('rejects malformed tokens before any lookup', () => {
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken('short')).toBe(false);
    expect(isWellFormedToken(`${generateSessionToken()}x`)).toBe(false);
    expect(isWellFormedToken("' OR 1=1 --aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });

  it('uses __Host- cookies when secure and strict same-site always', () => {
    expect(cookieNames(true).session).toBe('__Host-tp_session');
    expect(cookieNames(false).session).toBe('tp_session');
    expect(cookieOptions(false, 60)).toEqual({ httpOnly: true, secure: false, sameSite: 'strict', path: '/', maxAge: 60 });
  });
});

describe('pending (pre-2FA) ticket', () => {
  const now = 1_700_000_000_000;

  it('verifies within its lifetime and names the user', () => {
    const t = signPendingTicket(userId, now, key);
    expect(verifyPendingTicket(t, now + 1000, key)).toEqual({ userId });
  });

  it('expires', () => {
    const t = signPendingTicket(userId, now, key);
    expect(verifyPendingTicket(t, now + PENDING_TTL_MS + 1, key)).toBeNull();
  });

  it('rejects tampering and other keys', () => {
    const t = signPendingTicket(userId, now, key);
    const forged = t.replace(userId, '00000000-0000-0000-0000-000000000000');
    expect(verifyPendingTicket(forged, now, key)).toBeNull();
    const parts = t.split('.');
    parts[1] = String(now + 10 * PENDING_TTL_MS);
    expect(verifyPendingTicket(parts.join('.'), now, key)).toBeNull();
    expect(verifyPendingTicket(t, now, randomBytes(32))).toBeNull();
    expect(verifyPendingTicket(undefined, now, key)).toBeNull();
    expect(verifyPendingTicket(generateSessionToken(), now, key)).toBeNull();
  });
});
