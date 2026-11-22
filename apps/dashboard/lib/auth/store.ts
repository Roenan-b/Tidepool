/**
 * Persistence for dashboard users and sessions (auth_users, auth_sessions in 001_init.sql).
 * The interface lets the auth service be unit-tested with an in-memory fake.
 */
import type pg from 'pg';
import type { Role } from './guard.js';
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS, type ClaimResult, type LockState } from './lockout.js';

export interface UserRecord {
  id: string;
  username: string;
  role: Role;
  passwordHash: string;
  totpSecretEnc: string | null;
  totpEnabled: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  expiresAt: Date;
  lastSeenAt: Date;
  username: string;
  role: Role;
  totpEnabled: boolean;
}

export interface NewSession {
  idHash: string;
  userId: string;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface AuthStore {
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /**
   * Atomically counts one attempt before the credential is checked. Refused while the account is
   * locked or while the attempt budget is used up (which then locks it). See lockout.ts.
   */
  claimAttempt(userId: string, now: Date): Promise<ClaimResult>;
  /** Atomically turns a used-up attempt budget into a lock after a claimed attempt failed. */
  settleFailure(userId: string, now: Date): Promise<LockState>;
  /** Gives back one claimed attempt (correct password, TOTP still to come). */
  releaseAttempt(userId: string, now: Date): Promise<void>;
  resetFailures(userId: string): Promise<void>;
  createSession(s: NewSession, now: Date): Promise<void>;
  findSession(idHash: string, now: Date): Promise<SessionRecord | null>;
  touchSession(idHash: string, now: Date): Promise<void>;
  deleteSession(idHash: string): Promise<void>;
  /** Ends every session of a user (used when the account's sign-in requirements change). */
  deleteUserSessions(userId: string): Promise<void>;
  setTotpSecret(userId: string, secretEnc: string): Promise<void>;
  enableTotp(userId: string): Promise<boolean>;
  /** Persisted last accepted TOTP step (auth_users.totp_last_step, migration 002). */
  getTotpLastStep(userId: string): Promise<number | null | undefined>;
  /** Records a step only if it is newer; returns false when another request already used it. */
  recordTotpStep(userId: string, step: number): Promise<boolean>;
}

interface UserRow {
  id: string;
  username: string;
  role: Role;
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: boolean;
  failed_attempts: number;
  locked_until: Date | null;
}

function toUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    passwordHash: r.password_hash,
    totpSecretEnc: r.totp_secret_enc,
    totpEnabled: r.totp_enabled,
    failedAttempts: r.failed_attempts,
    lockedUntil: r.locked_until,
  };
}

const USER_COLUMNS = 'id, username, role, password_hash, totp_secret_enc, totp_enabled, failed_attempts, locked_until';

export class PgAuthStore implements AuthStore {
  constructor(private readonly pool: pg.Pool) {}

  async findUserByUsername(username: string): Promise<UserRecord | null> {
    const r = await this.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE username = $1`, [username]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    const r = await this.pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE id = $1`, [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async claimAttempt(userId: string, now: Date): Promise<ClaimResult> {
    // Row-level locking serializes concurrent UPDATEs on the same user, so at most
    // MAX_FAILED_ATTEMPTS claims succeed between a reset and a lock.
    const claimed = await this.pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      `UPDATE auth_users SET failed_attempts = failed_attempts + 1
        WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $2) AND failed_attempts < $3
        RETURNING failed_attempts, locked_until`,
      [userId, now, MAX_FAILED_ATTEMPTS],
    );
    const row = claimed.rows[0];
    if (row) return { allowed: true, state: { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until } };
    // Either locked already, or the budget is used up by attempts in flight: make that a lock.
    await this.pool.query(
      `UPDATE auth_users SET failed_attempts = 0, locked_until = $4
        WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $2) AND failed_attempts >= $3`,
      [userId, now, MAX_FAILED_ATTEMPTS, new Date(now.getTime() + LOCKOUT_MS)],
    );
    const r = await this.pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      'SELECT failed_attempts, locked_until FROM auth_users WHERE id = $1',
      [userId],
    );
    const cur = r.rows[0];
    return {
      allowed: false,
      state: { failedAttempts: cur?.failed_attempts ?? 0, lockedUntil: cur?.locked_until ?? null },
    };
  }

  async settleFailure(userId: string, now: Date): Promise<LockState> {
    // Every SET expression reads the old row, so both CASEs test the same failed_attempts value.
    const r = await this.pool.query<{ failed_attempts: number; locked_until: Date | null }>(
      `UPDATE auth_users SET
         failed_attempts = CASE WHEN failed_attempts >= $2 THEN 0 ELSE failed_attempts END,
         locked_until = CASE WHEN failed_attempts >= $2 THEN $3::timestamptz ELSE locked_until END
       WHERE id = $1
       RETURNING failed_attempts, locked_until`,
      [userId, MAX_FAILED_ATTEMPTS, new Date(now.getTime() + LOCKOUT_MS)],
    );
    const row = r.rows[0];
    return { failedAttempts: row?.failed_attempts ?? 0, lockedUntil: row?.locked_until ?? null };
  }

  async releaseAttempt(userId: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE auth_users SET failed_attempts = GREATEST(failed_attempts - 1, 0)
        WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $2)`,
      [userId, now],
    );
  }

  async resetFailures(userId: string): Promise<void> {
    await this.pool.query('UPDATE auth_users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);
  }

  async createSession(s: NewSession, now: Date): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE user_id = $1 AND expires_at <= $2', [s.userId, now]);
    await this.pool.query(
      `INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $3, $5, $6)`,
      [s.idHash, s.userId, now, s.expiresAt, s.ip, s.userAgent],
    );
  }

  async findSession(idHash: string, now: Date): Promise<SessionRecord | null> {
    const r = await this.pool.query<{
      id_hash: string;
      user_id: string;
      expires_at: Date;
      last_seen_at: Date;
      username: string;
      role: Role;
      totp_enabled: boolean;
    }>(
      `SELECT s.id_hash, s.user_id, s.expires_at, s.last_seen_at, u.username, u.role, u.totp_enabled
         FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
        WHERE s.id_hash = $1 AND s.expires_at > $2`,
      [idHash, now],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      idHash: row.id_hash,
      userId: row.user_id,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      username: row.username,
      role: row.role,
      totpEnabled: row.totp_enabled,
    };
  }

  async touchSession(idHash: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE auth_sessions SET last_seen_at = $2 WHERE id_hash = $1', [idHash, now]);
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE id_hash = $1', [idHash]);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_sessions WHERE user_id = $1', [userId]);
  }

  async setTotpSecret(userId: string, secretEnc: string): Promise<void> {
    await this.pool.query(
      'UPDATE auth_users SET totp_secret_enc = $2, totp_enabled = false WHERE id = $1 AND totp_enabled = false',
      [userId, secretEnc],
    );
  }

  async enableTotp(userId: string): Promise<boolean> {
    const r = await this.pool.query(
      'UPDATE auth_users SET totp_enabled = true WHERE id = $1 AND totp_enabled = false AND totp_secret_enc IS NOT NULL',
      [userId],
    );
    return (r.rowCount ?? 0) === 1;
  }

  /**
   * Requires db/migrations/002_totp_last_step.sql. The column is used unconditionally: if it is
   * missing the query fails and sign-in fails closed, instead of silently losing replay protection.
   */
  async getTotpLastStep(userId: string): Promise<number | null> {
    const r = await this.pool.query<{ totp_last_step: string | null }>(
      'SELECT totp_last_step FROM auth_users WHERE id = $1',
      [userId],
    );
    const v = r.rows[0]?.totp_last_step;
    return v === null || v === undefined ? null : Number(v);
  }

  async recordTotpStep(userId: string, step: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE auth_users SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [userId, step],
    );
    return (r.rowCount ?? 0) === 1;
  }
}
