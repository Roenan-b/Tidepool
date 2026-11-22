import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, type TestSchema } from '../db/testing.js';
import { PgAuditLog } from './pgAuditLog.js';
import { GENESIS_HASH, canonicalJson, eventHash, normalizeJson } from './canonical.js';

let db: TestSchema;
let audit: PgAuditLog;

beforeAll(async () => {
  db = await createTestSchema();
  audit = new PgAuditLog({ pool: db.pool });
});
afterAll(async () => {
  await db?.dispose();
});

describe('canonical json', () => {
  it('sorts keys recursively and renders bigints as strings', () => {
    const a = canonicalJson(normalizeJson({ b: 1n, a: { d: [3, { z: 1, y: 2 }], c: 'x' }, u: undefined }));
    expect(a).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":"1"}');
    const h1 = eventHash(GENESIS_HASH, { at: '2026-01-01T00:00:00.000Z', actor: 'risk', type: 't', ref: null, payload: { x: 1, y: 2 } });
    const h2 = eventHash(GENESIS_HASH, { at: '2026-01-01T00:00:00.000Z', actor: 'risk', type: 't', ref: null, payload: { y: 2, x: 1 } });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PgAuditLog', () => {
  it('chains appends from the genesis hash and verifies', async () => {
    const first = await audit.append({ actor: 'system', type: 'boot', payload: { amount: 123456789012345678901234567890n, nested: { b: 2, a: 1 }, when: new Date(0) } });
    const rows = await db.pool.query<{ prev_hash: string; hash: string }>('SELECT prev_hash, hash FROM audit_events WHERE seq = $1', [first.seq]);
    expect(rows.rows[0]!.prev_hash).toBe(GENESIS_HASH);
    expect(rows.rows[0]!.hash).toBe(first.hash);
    await audit.append({ actor: 'risk', type: 'x', ref: 'r1', payload: { f: 0.1 + 0.2, s: 'héllo "q"', arr: [1, null, 'a'] } });
    expect(await audit.verify()).toMatchObject({ ok: true, brokenAt: null });
  });

  it('does not fork under concurrent appends', async () => {
    await Promise.all(Array.from({ length: 200 }, (_, i) => audit.append({ actor: 'trader', type: 'concurrent', ref: String(i), payload: { i } })));
    const v = await audit.verify();
    expect(v.ok).toBe(true);
    const dupPrev = await db.pool.query('SELECT prev_hash FROM audit_events GROUP BY prev_hash HAVING count(*) > 1');
    expect(dupPrev.rowCount).toBe(0);
  });

  it('appendWith commits or rolls back with the caller transaction', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await audit.appendWith(client, { actor: 'risk', type: 'rolled_back', payload: {} });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await audit.appendWith(client, { actor: 'risk', type: 'committed', payload: {} });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const r = await db.pool.query<{ type: string }>(`SELECT type FROM audit_events WHERE type IN ('rolled_back','committed')`);
    expect(r.rows.map((x) => x.type)).toEqual(['committed']);
    expect((await audit.verify()).ok).toBe(true);
  });

  it('rejects invalid input', async () => {
    await expect(audit.append({ actor: 'nobody' as never, type: 'x', payload: {} })).rejects.toThrow(/actor/);
    await expect(audit.append({ actor: 'risk', type: '', payload: {} })).rejects.toThrow(/type/);
  });

  it('blocks UPDATE, DELETE and TRUNCATE via trigger', async () => {
    await expect(db.pool.query(`UPDATE audit_events SET type = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.pool.query('DELETE FROM audit_events')).rejects.toThrow(/append-only/);
    await expect(db.pool.query('TRUNCATE audit_events')).rejects.toThrow(/append-only/);
  });

  it('verify(fromSeq) checks a suffix of the chain', async () => {
    const last = await audit.append({ actor: 'system', type: 'tail', payload: {} });
    const v = await audit.verify(last.seq);
    expect(v).toEqual({ ok: true, brokenAt: null, checked: 1 });
  });

  it('detects a forged row inserted outside the chain', async () => {
    await audit.append({ actor: 'system', type: 'before_forgery', payload: {} });
    // A writer bypassing PgAuditLog: plausible-looking row whose prev_hash does not link.
    const forged = await db.pool.query<{ seq: string }>(
      `INSERT INTO audit_events (actor, type, ref, payload, prev_hash, hash) VALUES ('owner', 'withdrawal_booked', NULL, '{"lamports":"1"}', $1, $2) RETURNING seq`,
      [GENESIS_HASH, 'f'.repeat(64)],
    );
    const v = await audit.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(Number(forged.rows[0]!.seq));
  });
});

describe('tamper detection by a privileged user', () => {
  it('detects a payload edited with the trigger disabled', async () => {
    const t = await createTestSchema();
    try {
      const log = new PgAuditLog({ pool: t.pool });
      const a = await log.append({ actor: 'risk', type: 'reservation_approved', payload: { lamports: '100' } });
      await log.append({ actor: 'risk', type: 'other', payload: {} });
      expect((await log.verify()).ok).toBe(true);
      // Superuser path: disable the trigger, rewrite history, re-enable.
      await t.pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
      await t.pool.query(`UPDATE audit_events SET payload = '{"lamports":"999"}' WHERE seq = $1`, [a.seq]);
      await t.pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      expect(await log.verify()).toMatchObject({ ok: false, brokenAt: a.seq });
    } finally {
      await t.dispose();
    }
  });
});

describe('review regressions: unstorable characters', () => {
  it('stores payloads, keys and refs containing NUL or unpaired surrogates and still verifies', async () => {
    // Token metadata is untrusted; Postgres jsonb rejects \u0000 and lone surrogates, which used to abort the caller's transaction.
    const r = await audit.append({ actor: 'risk', type: 'reservation_approved', ref: 'mint\u0000x', payload: { symbol: 'EVIL\u0000COIN', lone: 'a\udc00b', ['k\u0000']: 1, ok: 'a\u{1F600}b' } });
    const row = await db.pool.query<{ ref: string; payload: Record<string, unknown> }>('SELECT ref, payload FROM audit_events WHERE seq = $1', [r.seq]);
    expect(row.rows[0]!.ref).toBe('mint�x');
    expect(row.rows[0]!.payload).toEqual({ symbol: 'EVIL�COIN', lone: 'a�b', ['k�']: 1, ok: 'a\u{1F600}b' });
    // An earlier test in this file deliberately forges a row, so verify from this event onwards.
    expect(await audit.verify(r.seq)).toMatchObject({ ok: true, brokenAt: null, checked: 1 });
  });
});
