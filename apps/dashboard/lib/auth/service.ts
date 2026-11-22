/**
 * Sign-in flows. Route handlers stay thin: they parse input, call these functions and set cookies.
 *
 * Password step -> (TOTP enrolled)     pending ticket -> TOTP step -> session
 *               -> (TOTP not enrolled) restricted session that can only enroll TOTP
 *
 * Every password or TOTP check claims an attempt from the lockout budget before it runs (see
 * lockout.ts), so concurrent guesses cannot exceed the limit. Enabling TOTP ends every session of the
 * user, including password-only sessions opened elsewhere, and issues a fresh one to the enrolling client.
 */
import { z } from 'zod';
import type { Viewer } from './guard.js';
import { isLocked, minutesRemaining, type LockState } from './lockout.js';
import { burnPasswordCheck, verifyPassword } from './password.js';
import { decryptSecret, encryptSecret } from './secretBox.js';
import {
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
  signPendingTicket,
  verifyPendingTicket,
} from './session.js';
import type { AuthStore, UserRecord } from './store.js';
import { base32Encode } from './base32.js';
import { ReplayGuard, generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const LoginBody = z.object({
  username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(1).max(1024),
});
export const TotpBody = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthDeps {
  store: AuthStore;
  key: Buffer;
  sessionTtlHours: number;
  replay: ReplayGuard;
  now?: () => Date;
}

export type PasswordResult =
  | { kind: 'invalid' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'totp_required'; pendingTicket: string }
  | { kind: 'session'; token: string; expiresAt: Date; enrollmentRequired: true };

export type EnrollmentResult =
  | { kind: 'ok'; token: string; expiresAt: Date }
  | { kind: 'invalid' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'already_enabled' };

export type TotpResult =
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'locked'; minutes: number }
  | { kind: 'session'; token: string; expiresAt: Date };

/** Session refresh of last_seen_at is throttled to one write per minute. */
const TOUCH_INTERVAL_MS = 60_000;

export class AuthService {
  private readonly now: () => Date;

  constructor(private readonly deps: AuthDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async newSession(user: UserRecord, meta: RequestMeta): Promise<{ token: string; expiresAt: Date }> {
    const now = this.now();
    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + this.deps.sessionTtlHours * 3600_000);
    await this.deps.store.createSession(
      {
        idHash: hashSessionToken(token),
        userId: user.id,
        expiresAt,
        ip: meta.ip?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 256) ?? null,
      },
      now,
    );
    return { token, expiresAt };
  }

  private lockedResult(state: LockState, now: Date): { kind: 'locked'; minutes: number } {
    return { kind: 'locked', minutes: Math.max(1, minutesRemaining(state, now)) };
  }

  /** Counts a failed, already claimed attempt; returns the locked result if that used up the budget. */
  private async failed(userId: string, now: Date): Promise<{ kind: 'invalid' } | { kind: 'locked'; minutes: number }> {
    const state = await this.deps.store.settleFailure(userId, now);
    return isLocked(state, now) ? this.lockedResult(state, now) : { kind: 'invalid' };
  }

  async passwordStep(username: string, password: string, meta: RequestMeta): Promise<PasswordResult> {
    const now = this.now();
    const user = await this.deps.store.findUserByUsername(username);
    if (!user) {
      await burnPasswordCheck(password);
      return { kind: 'invalid' };
    }
    const claim = await this.deps.store.claimAttempt(user.id, now);
    if (!claim.allowed) {
      // Spend the same work as a real check so a locked account answers no faster than a wrong password.
      await burnPasswordCheck(password);
      return this.lockedResult(claim.state, now);
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return this.failed(user.id, now);
    if (user.totpEnabled) {
      // A correct password is not a failure, but failures are not reset until the second factor
      // passes, so TOTP guessing still counts toward the lockout.
      await this.deps.store.releaseAttempt(user.id, now);
      return { kind: 'totp_required', pendingTicket: signPendingTicket(user.id, now.getTime(), this.deps.key) };
    }
    await this.deps.store.resetFailures(user.id);
    const s = await this.newSession(user, meta);
    return { kind: 'session', ...s, enrollmentRequired: true };
  }

  private async lastStep(userId: string): Promise<number | null> {
    const persisted = await this.deps.store.getTotpLastStep(userId);
    const mem = this.deps.replay.lastStep(userId);
    if (persisted === undefined || persisted === null) return mem;
    return mem === null ? persisted : Math.max(mem, persisted);
  }

  private async checkCode(user: UserRecord, code: string): Promise<boolean> {
    if (!user.totpSecretEnc) return false;
    let secret: Buffer;
    try {
      secret = decryptSecret(user.totpSecretEnc, this.deps.key, user.id);
    } catch {
      return false;
    }
    const result = verifyTotp(secret, code, this.now().getTime(), await this.lastStep(user.id));
    secret.fill(0);
    if (!result.ok) return false;
    const fresh = await this.deps.store.recordTotpStep(user.id, result.step);
    if (!fresh) return false;
    this.deps.replay.record(user.id, result.step);
    return true;
  }

  async totpStep(pendingTicket: string | undefined, code: string, meta: RequestMeta): Promise<TotpResult> {
    const now = this.now();
    const pending = verifyPendingTicket(pendingTicket, now.getTime(), this.deps.key);
    if (!pending) return { kind: 'expired' };
    const user = await this.deps.store.findUserById(pending.userId);
    if (!user || !user.totpEnabled) return { kind: 'expired' };
    const claim = await this.deps.store.claimAttempt(user.id, now);
    if (!claim.allowed) return this.lockedResult(claim.state, now);
    if (!(await this.checkCode(user, code))) return this.failed(user.id, now);
    await this.deps.store.resetFailures(user.id);
    return { kind: 'session', ...(await this.newSession(user, meta)) };
  }

  async resolveSession(token: string | undefined): Promise<Viewer | null> {
    if (!isWellFormedToken(token)) return null;
    const now = this.now();
    const idHash = hashSessionToken(token);
    const s = await this.deps.store.findSession(idHash, now);
    if (!s) return null;
    if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.deps.store.touchSession(idHash, now).catch(() => undefined);
    }
    return { userId: s.userId, username: s.username, role: s.role, totpEnabled: s.totpEnabled, demo: false };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!isWellFormedToken(token)) return;
    await this.deps.store.deleteSession(hashSessionToken(token));
  }

  async startEnrollment(viewer: Viewer): Promise<{ kind: 'already_enabled' } | { kind: 'ok'; uri: string; secretBase32: string }> {
    const user = await this.deps.store.findUserById(viewer.userId);
    if (!user) return { kind: 'already_enabled' };
    if (user.totpEnabled) return { kind: 'already_enabled' };
    const secret = generateTotpSecret();
    await this.deps.store.setTotpSecret(user.id, encryptSecret(secret, this.deps.key, user.id));
    const out = { kind: 'ok' as const, uri: otpauthUri(secret, user.username), secretBase32: base32Encode(secret) };
    secret.fill(0);
    return out;
  }

  /**
   * Enables TOTP after a valid code. Sessions are looked up with the user's current totp_enabled flag,
   * so any password-only session would otherwise become a full session at this moment. All of the
   * user's sessions are therefore ended and the enrolling client gets a new one (which also rotates
   * the token that existed before the second factor was proven).
   */
  async confirmEnrollment(viewer: Viewer, code: string, meta: RequestMeta = { ip: null, userAgent: null }): Promise<EnrollmentResult> {
    const now = this.now();
    const user = await this.deps.store.findUserById(viewer.userId);
    if (!user || user.totpEnabled) return { kind: 'already_enabled' };
    const claim = await this.deps.store.claimAttempt(user.id, now);
    if (!claim.allowed) return this.lockedResult(claim.state, now);
    if (!(await this.checkCode(user, code))) return this.failed(user.id, now);
    if (!(await this.deps.store.enableTotp(user.id))) return { kind: 'already_enabled' };
    await this.deps.store.resetFailures(user.id);
    await this.deps.store.deleteUserSessions(user.id);
    return { kind: 'ok', ...(await this.newSession(user, meta)) };
  }
}
