import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Viewer } from './guard.js';
import { claimAttempt, releaseAttempt, settleFailure, type ClaimResult, type LockState } from './lockout.js';
import { hashPassword } from './password.js';
import { encryptSecret } from './secretBox.js';
import { AuthService } from './service.js';
import type { AuthStore, NewSession, SessionRecord, UserRecord } from './store.js';
import { ReplayGuard, hotp, timeStep } from './totp.js';
import { base32Decode } from './base32.js';

class MemoryStore implements AuthStore {
  users = new Map<string, UserRecord>();
  sessions = new Map<string, NewSession & { lastSeenAt: Date }>();
  lastStep = new Map<string, number>();
  lastStepReads = 0;
  async findUserByUsername(u: string) { return [...this.users.values()].find((x) => x.username === u) ?? null; }
  async findUserById(id: string) { return this.users.get(id) ?? null; }
  private apply(id: string, s: LockState): LockState {
    const u = this.users.get(id)!;
    u.failedAttempts = s.failedAttempts;
    u.lockedUntil = s.lockedUntil;
    return s;
  }
  // Each method reads and writes the user synchronously, like one atomic UPDATE in PostgreSQL.
  async claimAttempt(id: string, now: Date): Promise<ClaimResult> {
    const r = claimAttempt(this.users.get(id)!, now);
    this.apply(id, r.state);
    return r;
  }
  async settleFailure(id: string, now: Date) { return this.apply(id, settleFailure(this.users.get(id)!, now)); }
  async releaseAttempt(id: string, now: Date) { this.apply(id, releaseAttempt(this.users.get(id)!, now)); }
  async resetFailures(id: string) { const u = this.users.get(id)!; u.failedAttempts = 0; u.lockedUntil = null; }
  async createSession(s: NewSession, now: Date) { this.sessions.set(s.idHash, { ...s, lastSeenAt: now }); }
  async findSession(idHash: string, now: Date): Promise<SessionRecord | null> {
    const s = this.sessions.get(idHash);
    if (!s || s.expiresAt <= now) return null;
    const u = this.users.get(s.userId)!;
    return { idHash, userId: u.id, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt, username: u.username, role: u.role, totpEnabled: u.totpEnabled };
  }
  async touchSession(idHash: string, now: Date) { const s = this.sessions.get(idHash); if (s) s.lastSeenAt = now; }
  async deleteSession(idHash: string) { this.sessions.delete(idHash); }
  async deleteUserSessions(userId: string) { for (const [k, v] of this.sessions) if (v.userId === userId) this.sessions.delete(k); }
  async setTotpSecret(id: string, enc: string) { const u = this.users.get(id)!; if (!u.totpEnabled) u.totpSecretEnc = enc; }
  async enableTotp(id: string) { const u = this.users.get(id)!; if (u.totpEnabled || !u.totpSecretEnc) return false; u.totpEnabled = true; return true; }
  async getTotpLastStep(id: string) { this.lastStepReads += 1; return this.lastStep.get(id) ?? null; }
  async recordTotpStep(id: string, step: number) {
    const prev = this.lastStep.get(id);
    if (prev !== undefined && prev >= step) return false;
    this.lastStep.set(id, step);
    return true;
  }
}

const FAST = { N: 1024, r: 8, p: 1 };
const key = randomBytes(32);
const meta = { ip: '127.0.0.1', userAgent: 'test' };
const totpSecret = Buffer.from('12345678901234567890');

describe('AuthService', () => {
  let store: MemoryStore;
  let clock: Date;
  let svc: AuthService;
  let jake: UserRecord;
  let roe: UserRecord;

  beforeEach(async () => {
    store = new MemoryStore();
    clock = new Date('2026-11-22T12:00:00Z');
    svc = new AuthService({ store, key, sessionTtlHours: 12, replay: new ReplayGuard(), now: () => clock });
    const jakeId = randomUUID();
    jake = {
      id: jakeId, username: 'jake', role: 'owner', passwordHash: await hashPassword('jake-password-1', FAST),
      totpSecretEnc: encryptSecret(totpSecret, key, jakeId), totpEnabled: true, failedAttempts: 0, lockedUntil: null,
    };
    roe = {
      id: randomUUID(), username: 'roe', role: 'operator', passwordHash: await hashPassword('roe-password-12', FAST),
      totpSecretEnc: null, totpEnabled: false, failedAttempts: 0, lockedUntil: null,
    };
    store.users.set(jake.id, jake);
    store.users.set(roe.id, roe);
  });

  it('requires TOTP after a correct password and grants no session before it', async () => {
    const r = await svc.passwordStep('jake', 'jake-password-1', meta);
    expect(r.kind).toBe('totp_required');
    expect(store.sessions.size).toBe(0);
    if (r.kind !== 'totp_required') return;
    // The pending ticket is not a session token.
    expect(await svc.resolveSession(r.pendingTicket)).toBeNull();
    const code = hotp(totpSecret, timeStep(clock.getTime()));
    const t = await svc.totpStep(r.pendingTicket, code, meta);
    expect(t.kind).toBe('session');
    if (t.kind !== 'session') return;
    const viewer = await svc.resolveSession(t.token);
    expect(viewer).toMatchObject({ username: 'jake', role: 'owner', totpEnabled: true, demo: false });
    // Only the hash is stored.
    expect([...store.sessions.keys()][0]).not.toBe(t.token);
  });

  it('rejects a replayed TOTP code', async () => {
    const code = hotp(totpSecret, timeStep(clock.getTime()));
    const p1 = await svc.passwordStep('jake', 'jake-password-1', meta);
    if (p1.kind !== 'totp_required') throw new Error('expected totp');
    expect((await svc.totpStep(p1.pendingTicket, code, meta)).kind).toBe('session');
    const p2 = await svc.passwordStep('jake', 'jake-password-1', meta);
    if (p2.kind !== 'totp_required') throw new Error('expected totp');
    expect((await svc.totpStep(p2.pendingTicket, code, meta)).kind).toBe('invalid');
  });

  it('locks after five failures across password and TOTP and refuses even the right password', async () => {
    for (let i = 0; i < 4; i++) expect((await svc.passwordStep('jake', 'wrong-password', meta)).kind).toBe('invalid');
    const p = await svc.passwordStep('jake', 'jake-password-1', meta);
    if (p.kind !== 'totp_required') throw new Error('expected totp');
    const locked = await svc.totpStep(p.pendingTicket, '000000', meta);
    expect(locked.kind).toBe('locked');
    expect((await svc.passwordStep('jake', 'jake-password-1', meta)).kind).toBe('locked');
    clock = new Date(clock.getTime() + 16 * 60_000);
    expect((await svc.passwordStep('jake', 'jake-password-1', meta)).kind).toBe('totp_required');
  });

  it('gives unenrolled users a restricted session and enables TOTP only with a valid code', async () => {
    const r = await svc.passwordStep('roe', 'roe-password-12', meta);
    expect(r.kind).toBe('session');
    if (r.kind !== 'session') return;
    const viewer = (await svc.resolveSession(r.token)) as Viewer;
    expect(viewer.totpEnabled).toBe(false);
    const e = await svc.startEnrollment(viewer);
    if (e.kind !== 'ok') throw new Error('expected enrollment');
    expect(e.uri).toContain('otpauth://totp/');
    expect((await svc.confirmEnrollment(viewer, '000000')).kind).toBe('invalid');
    const secret = base32Decode(e.secretBase32);
    const ok = await svc.confirmEnrollment(viewer, hotp(secret, timeStep(clock.getTime())));
    expect(ok.kind).toBe('ok');
    if (ok.kind !== 'ok') return;
    // The pre-enrollment token is rotated out; the client continues on the new session.
    expect(await svc.resolveSession(r.token)).toBeNull();
    expect((await svc.resolveSession(ok.token))?.totpEnabled).toBe(true);
    expect((await svc.startEnrollment(viewer)).kind).toBe('already_enabled');
  });

  it('does not let a password-only session opened elsewhere become a full session when TOTP is enabled', async () => {
    // An attacker with the password signs in before the owner enrolls and keeps the restricted session.
    const attacker = await svc.passwordStep('roe', 'roe-password-12', meta);
    if (attacker.kind !== 'session') throw new Error('expected session');
    const mine = await svc.passwordStep('roe', 'roe-password-12', meta);
    if (mine.kind !== 'session') throw new Error('expected session');
    const viewer = (await svc.resolveSession(mine.token)) as Viewer;
    const e = await svc.startEnrollment(viewer);
    if (e.kind !== 'ok') throw new Error('expected enrollment');
    const ok = await svc.confirmEnrollment(viewer, hotp(base32Decode(e.secretBase32), timeStep(clock.getTime())));
    expect(ok.kind).toBe('ok');
    // Without the fix this resolved to a viewer with totpEnabled: true, i.e. full access without TOTP.
    expect(await svc.resolveSession(attacker.token)).toBeNull();
  });

  it('evaluates at most five TOTP guesses when many arrive concurrently', async () => {
    const p = await svc.passwordStep('jake', 'jake-password-1', meta);
    if (p.kind !== 'totp_required') throw new Error('expected totp');
    const right = hotp(totpSecret, timeStep(clock.getTime()));
    const wrong = right === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 40 }, () => svc.totpStep(p.pendingTicket, wrong, meta)));
    // Each evaluated code reads the last accepted step once; a stale lock check let all 40 through.
    expect(store.lastStepReads).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.kind === 'locked').length).toBeGreaterThanOrEqual(35);
    // The correct code is refused while locked.
    expect((await svc.totpStep(p.pendingTicket, right, meta)).kind).toBe('locked');
  });

  it('counts concurrent wrong passwords against the same five-attempt budget', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => svc.passwordStep('jake', 'wrong-password', meta)));
    expect(results.filter((r) => r.kind === 'invalid').length).toBeLessThanOrEqual(4);
    expect((await svc.passwordStep('jake', 'jake-password-1', meta)).kind).toBe('locked');
  });

  it('does not charge a correct password against the lockout budget', async () => {
    for (let i = 0; i < 6; i++) expect((await svc.passwordStep('jake', 'jake-password-1', meta)).kind).toBe('totp_required');
    expect(jake.failedAttempts).toBe(0);
  });

  it('returns the same answer for unknown users and wrong passwords', async () => {
    expect((await svc.passwordStep('nobody', 'whatever-pass', meta)).kind).toBe('invalid');
    expect((await svc.passwordStep('jake', 'whatever-pass', meta)).kind).toBe('invalid');
  });

  it('expires sessions and logs out', async () => {
    const r = await svc.passwordStep('roe', 'roe-password-12', meta);
    if (r.kind !== 'session') throw new Error('expected session');
    clock = new Date(clock.getTime() + 13 * 3600_000);
    expect(await svc.resolveSession(r.token)).toBeNull();
    const r2 = await svc.passwordStep('roe', 'roe-password-12', meta);
    if (r2.kind !== 'session') throw new Error('expected session');
    await svc.logout(r2.token);
    expect(await svc.resolveSession(r2.token)).toBeNull();
  });
});
