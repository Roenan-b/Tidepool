/**
 * Integration test for PgAuthStore against the local test database. Each run uses an isolated schema
 * with the shared migration applied, and drops it afterwards.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAuthStore } from './store.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://memebot:memebot@127.0.0.1:5432/memebot_test';
const schema = `test_dash_${randomBytes(4).toString('hex')}`;
const migrations = ['001_init.sql', '002_totp_last_step.sql'].map((f) =>
  readFileSync(fileURLToPath(new URL(`../../../../db/migrations/${f}`, import.meta.url)), 'utf8'),
);

async function reachable(): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const dbUp = await reachable();

describe.skipIf(!dbUp)('PgAuthStore (postgres)', () => {
  let pool: pg.Pool;
  let store: PgAuthStore;
  const userId = randomUUID();

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(`SET search_path TO ${schema}`);
    for (const m of migrations) await admin.query(m);
    await admin.end();
    pool = new pg.Pool({ connectionString: url, max: 2, options: `-c search_path=${schema}` });
    store = new PgAuthStore(pool);
    await pool.query(`INSERT INTO auth_users (id, username, role, password_hash) VALUES ($1, 'jake', 'owner', 'scrypt$x')`, [userId]);
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('finds users by name and id', async () => {
    const u = await store.findUserByUsername('jake');
    expect(u).toMatchObject({ id: userId, role: 'owner', totpEnabled: false, failedAttempts: 0, lockedUntil: null });
    expect((await store.findUserById(userId))?.username).toBe('jake');
    expect(await store.findUserByUsername('nobody')).toBeNull();
  });

  it('claims attempts up front, locks when the budget is used and resets', async () => {
    const now = new Date();
    for (let i = 1; i <= 5; i++) {
      const c = await store.claimAttempt(userId, now);
      expect(c.allowed).toBe(true);
      expect(c.state.failedAttempts).toBe(i);
      const settled = await store.settleFailure(userId, now);
      if (i < 5) expect(settled).toMatchObject({ failedAttempts: i, lockedUntil: null });
      else expect(settled.lockedUntil!.getTime()).toBeGreaterThan(now.getTime() + 14 * 60_000);
    }
    expect((await store.claimAttempt(userId, now)).allowed).toBe(false);
    // The lock expires on its own.
    expect((await store.claimAttempt(userId, new Date(now.getTime() + 16 * 60_000))).allowed).toBe(true);
    await store.resetFailures(userId);
    expect(await store.findUserById(userId)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it('allows at most five concurrent claims and then locks', async () => {
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claimAttempt(userId, now)));
    expect(results.filter((r) => r.allowed).length).toBe(5);
    const u = await store.findUserById(userId);
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(now.getTime());
    await store.resetFailures(userId);
  });

  it('gives back a released attempt but not while locked', async () => {
    const now = new Date();
    await store.claimAttempt(userId, now);
    await store.claimAttempt(userId, now);
    await store.releaseAttempt(userId, now);
    expect((await store.findUserById(userId))?.failedAttempts).toBe(1);
    await store.resetFailures(userId);
  });

  it('ends every session of a user', async () => {
    const now = new Date();
    const exp = new Date(now.getTime() + 3600_000);
    await store.createSession({ idHash: 'b'.repeat(64), userId, expiresAt: exp, ip: null, userAgent: null }, now);
    await store.createSession({ idHash: 'c'.repeat(64), userId, expiresAt: exp, ip: null, userAgent: null }, now);
    await store.deleteUserSessions(userId);
    expect(await store.findSession('b'.repeat(64), now)).toBeNull();
    expect(await store.findSession('c'.repeat(64), now)).toBeNull();
  });

  it('creates, finds, expires and deletes sessions by hash', async () => {
    const now = new Date();
    const idHash = 'a'.repeat(64);
    await store.createSession({ idHash, userId, expiresAt: new Date(now.getTime() + 3600_000), ip: '127.0.0.1', userAgent: 'test' }, now);
    expect((await store.findSession(idHash, now))?.username).toBe('jake');
    expect(await store.findSession(idHash, new Date(now.getTime() + 7200_000))).toBeNull();
    await store.deleteSession(idHash);
    expect(await store.findSession(idHash, now)).toBeNull();
  });

  it('stores a pending TOTP secret and enables it once', async () => {
    await store.setTotpSecret(userId, 'v1.enc');
    expect((await store.findUserById(userId))?.totpSecretEnc).toBe('v1.enc');
    expect(await store.enableTotp(userId)).toBe(true);
    expect(await store.enableTotp(userId)).toBe(false);
    await store.setTotpSecret(userId, 'v1.other');
    expect((await store.findUserById(userId))?.totpSecretEnc).toBe('v1.enc');
  });

  it('persists the last TOTP step (migration 002) and refuses the same or an older step', async () => {
    expect(await store.getTotpLastStep(userId)).toBeNull();
    expect(await store.recordTotpStep(userId, 100)).toBe(true);
    expect(await store.recordTotpStep(userId, 100)).toBe(false);
    expect(await store.recordTotpStep(userId, 99)).toBe(false);
    // A second store (a restarted dashboard) sees the same step.
    expect(await new PgAuthStore(pool).getTotpLastStep(userId)).toBe(100);
    // Concurrent use of one step: exactly one wins.
    const both = await Promise.all([store.recordTotpStep(userId, 101), store.recordTotpStep(userId, 101)]);
    expect(both.filter(Boolean).length).toBe(1);
  });

  it('fails closed when the totp_last_step column is missing', async () => {
    await pool.query('ALTER TABLE auth_users DROP COLUMN totp_last_step');
    await expect(store.getTotpLastStep(userId)).rejects.toThrow();
    await expect(store.recordTotpStep(userId, 500)).rejects.toThrow();
  });
});
