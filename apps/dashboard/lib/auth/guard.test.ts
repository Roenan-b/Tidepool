import { describe, expect, it } from 'vitest';
import { authorize, pageRedirect, type Viewer } from './guard.js';
import {
  afterFailure,
  claimAttempt,
  isLocked,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  minutesRemaining,
  releaseAttempt,
  settleFailure,
} from './lockout.js';
import { checkSameOrigin } from './origin.js';

const base: Viewer = { userId: 'u', username: 'x', role: 'owner', totpEnabled: true, demo: false };
const owner = base;
const operator: Viewer = { ...base, role: 'operator' };
const unenrolled: Viewer = { ...base, totpEnabled: false };
const demo: Viewer = { ...base, demo: true };

describe('authorize', () => {
  it('requires a viewer', () => {
    expect(authorize(null, { roles: ['owner'] })).toMatchObject({ ok: false, status: 401, code: 'unauthenticated' });
  });

  it('enforces roles', () => {
    expect(authorize(owner, { roles: ['owner'] }).ok).toBe(true);
    expect(authorize(operator, { roles: ['owner'] })).toMatchObject({ ok: false, status: 403, code: 'forbidden' });
    expect(authorize(owner, { roles: ['operator'] })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('confines users without TOTP to enrollment', () => {
    expect(authorize(unenrolled, { roles: ['owner'] })).toMatchObject({ ok: false, code: 'totp_enrollment_required' });
    expect(authorize(unenrolled, { roles: ['owner'], allowWithoutTotp: true }).ok).toBe(true);
  });

  it('lets demo viewers read everything and mutate nothing', () => {
    expect(authorize(demo, { roles: ['operator'] }).ok).toBe(true);
    expect(authorize(demo, { roles: ['owner'], mutating: true })).toMatchObject({ ok: false, code: 'demo_read_only' });
  });
});

describe('pageRedirect', () => {
  it('routes each viewer to a page they may use', () => {
    expect(pageRedirect(null, 'home')).toBe('/login');
    expect(pageRedirect(unenrolled, 'home')).toBe('/settings/security');
    expect(pageRedirect(unenrolled, 'security')).toBeNull();
    expect(pageRedirect(owner, 'ops')).toBe('/');
    expect(pageRedirect(operator, 'ops')).toBeNull();
    expect(pageRedirect(operator, 'home')).toBeNull();
    expect(pageRedirect(demo, 'ops')).toBeNull();
  });
});

describe('checkSameOrigin', () => {
  const allowed = 'https://dash.example.test';
  it('accepts the exact origin', () => {
    expect(checkSameOrigin({ origin: allowed, secFetchSite: 'same-origin' }, allowed).ok).toBe(true);
    expect(checkSameOrigin({ origin: allowed, secFetchSite: null }, allowed).ok).toBe(true);
  });
  it('rejects missing, null, foreign and look-alike origins', () => {
    expect(checkSameOrigin({ origin: null, secFetchSite: null }, allowed).ok).toBe(false);
    expect(checkSameOrigin({ origin: 'null', secFetchSite: null }, allowed).ok).toBe(false);
    expect(checkSameOrigin({ origin: 'https://evil.test', secFetchSite: null }, allowed).ok).toBe(false);
    expect(checkSameOrigin({ origin: 'https://dash.example.test.evil.test', secFetchSite: null }, allowed).ok).toBe(
      false,
    );
    expect(checkSameOrigin({ origin: 'http://dash.example.test', secFetchSite: null }, allowed).ok).toBe(false);
    expect(checkSameOrigin({ origin: 'https://dash.example.test:8443', secFetchSite: null }, allowed).ok).toBe(false);
  });
  it('rejects cross-site fetch metadata even with a matching Origin', () => {
    expect(checkSameOrigin({ origin: allowed, secFetchSite: 'cross-site' }, allowed).ok).toBe(false);
    expect(checkSameOrigin({ origin: allowed, secFetchSite: 'same-site' }, allowed).ok).toBe(false);
  });
});

describe('lockout', () => {
  it('locks for 15 minutes on the fifth failure', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let s = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      s = afterFailure(s, now);
      expect(isLocked(s, now)).toBe(false);
    }
    s = afterFailure(s, now);
    expect(isLocked(s, now)).toBe(true);
    expect(s.lockedUntil?.getTime()).toBe(now.getTime() + LOCKOUT_MS);
    expect(minutesRemaining(s, now)).toBe(15);
    expect(isLocked(s, new Date(now.getTime() + LOCKOUT_MS + 1))).toBe(false);
  });

  it('claims attempts before checking so a stale read cannot exceed the budget', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let s = { failedAttempts: 0, lockedUntil: null as Date | null };
    let allowed = 0;
    // Twenty attempts claimed before any of them settles (concurrent requests).
    for (let i = 0; i < 20; i++) {
      const c = claimAttempt(s, now);
      s = c.state;
      if (c.allowed) allowed += 1;
    }
    expect(allowed).toBe(MAX_FAILED_ATTEMPTS);
    expect(isLocked(s, now)).toBe(true);
    // Settling the in-flight failures keeps the lock.
    expect(isLocked(settleFailure(s, now), now)).toBe(true);
  });

  it('settles the fifth claimed failure into a lock and releases a correct password', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let s = { failedAttempts: 4, lockedUntil: null as Date | null };
    const c = claimAttempt(s, now);
    expect(c.allowed).toBe(true);
    s = settleFailure(c.state, now);
    expect(s).toEqual({ failedAttempts: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) });
    expect(releaseAttempt({ failedAttempts: 3, lockedUntil: null }, now)).toEqual({
      failedAttempts: 2,
      lockedUntil: null,
    });
    expect(releaseAttempt(s, now)).toBe(s);
  });
});
