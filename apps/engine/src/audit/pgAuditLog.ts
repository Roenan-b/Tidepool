import type pg from 'pg';
import type { AuditEvent } from '@tidepool/core';
import type { AuditLog, Clock } from '../contracts.js';
import { systemClock } from '../contracts.js';
import { GENESIS_HASH, eventHash, normalizeJson, storableString } from './canonical.js';

export type AuditActor = AuditEvent['actor'];
export type AuditInput = Parameters<AuditLog['append']>[0] & { at?: Date };

const ACTORS = new Set<AuditActor>(['scout', 'trader', 'risk', 'signer', 'operator', 'owner', 'system']);
/** Namespace for the advisory lock that serializes chain appends (second key is the schema). */
const AUDIT_LOCK_KEY = 7_420_002;
const MAX_TYPE_LEN = 100;
const MAX_REF_LEN = 300;
const VERIFY_BATCH = 1000;

interface AuditRow {
  seq: string;
  at: Date;
  actor: string;
  type: string;
  ref: string | null;
  payload: unknown;
  prev_hash: string;
  hash: string;
}

function toEvent(r: AuditRow): AuditEvent {
  return {
    seq: Number(r.seq),
    at: r.at.toISOString(),
    actor: r.actor as AuditActor,
    type: r.type,
    ref: r.ref,
    payload: r.payload as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/**
 * Append-only, hash-chained audit log in Postgres.
 *
 * Appends take a transaction-scoped advisory lock, read the last hash and insert, so the chain
 * cannot fork under concurrency. `appendWith` runs inside a caller's open transaction, letting the
 * Risk Officer commit a ledger change and its audit event atomically. Callers holding row locks
 * should append last in their transaction to keep the lock order consistent (row locks, then audit).
 */
export class PgAuditLog implements AuditLog {
  private readonly pool: pg.Pool;
  private readonly clock: Clock;

  constructor(opts: { pool: pg.Pool; clock?: Clock }) {
    this.pool = opts.pool;
    this.clock = opts.clock ?? systemClock;
  }

  async append(e: AuditInput): Promise<{ seq: number; hash: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await this.appendWith(client, e);
      await client.query('COMMIT');
      return res;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Appends inside the caller's transaction. `client` must already be inside BEGIN. */
  async appendWith(client: pg.PoolClient, e: AuditInput): Promise<{ seq: number; hash: string }> {
    if (!ACTORS.has(e.actor)) throw new Error(`invalid audit actor: ${String(e.actor)}`);
    if (typeof e.type !== 'string' || e.type.length === 0 || e.type.length > MAX_TYPE_LEN)
      throw new Error('invalid audit event type');
    const rawRef = e.ref ?? null;
    if (rawRef !== null && (typeof rawRef !== 'string' || rawRef.length > MAX_REF_LEN))
      throw new Error('invalid audit ref');
    const type = storableString(e.type);
    const ref = rawRef === null ? null : storableString(rawRef);
    const payload = normalizeJson(e.payload ?? {});
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload))
      throw new Error('audit payload must be an object');
    // Millisecond precision so the stored timestamptz round-trips to the same ISO string.
    const at = new Date((e.at ?? this.clock.now()).getTime()).toISOString();

    await client.query('SELECT pg_advisory_xact_lock($1, hashtext(current_schema()))', [AUDIT_LOCK_KEY]);
    const last = await client.query<{ hash: string }>('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const prevHash = last.rows[0]?.hash ?? GENESIS_HASH;
    const hash = eventHash(prevHash, { at, actor: e.actor, type, ref, payload });
    const ins = await client.query<{ seq: string }>(
      'INSERT INTO audit_events (at, actor, type, ref, payload, prev_hash, hash) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING seq',
      [at, e.actor, type, ref, JSON.stringify(payload), prevHash, hash],
    );
    return { seq: Number(ins.rows[0]!.seq), hash };
  }

  /**
   * Recomputes the chain from `fromSeq` (or the start). Checks that each row links to the previous
   * row's hash and that its own hash matches its contents. Returns the first broken seq.
   */
  async verify(fromSeq?: number): Promise<{ ok: boolean; brokenAt: number | null; checked: number }> {
    let expectedPrev = GENESIS_HASH;
    let cursor = 0;
    if (fromSeq !== undefined && fromSeq > 1) {
      const prev = await this.pool.query<{ seq: string; hash: string }>(
        'SELECT seq, hash FROM audit_events WHERE seq < $1 ORDER BY seq DESC LIMIT 1',
        [fromSeq],
      );
      if (prev.rows[0]) {
        expectedPrev = prev.rows[0].hash;
        cursor = Number(prev.rows[0].seq);
      }
    }
    let checked = 0;
    for (;;) {
      const batch = await this.pool.query<AuditRow>(
        'SELECT seq, at, actor, type, ref, payload, prev_hash, hash FROM audit_events WHERE seq > $1 ORDER BY seq ASC LIMIT $2',
        [cursor, VERIFY_BATCH],
      );
      if (batch.rows.length === 0) break;
      for (const r of batch.rows) {
        const seq = Number(r.seq);
        const recomputed = eventHash(r.prev_hash, {
          at: r.at.toISOString(),
          actor: r.actor,
          type: r.type,
          ref: r.ref,
          payload: r.payload,
        });
        if (r.prev_hash !== expectedPrev || recomputed !== r.hash) return { ok: false, brokenAt: seq, checked };
        expectedPrev = r.hash;
        cursor = seq;
        checked++;
      }
    }
    return { ok: true, brokenAt: null, checked };
  }

  /** Most recent events first; `before` is an exclusive seq cursor for paging. */
  async list(
    opts: { limit?: number; before?: number | null; ref?: string; type?: string } = {},
  ): Promise<AuditEvent[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 500);
    const params: unknown[] = [limit];
    const where: string[] = [];
    if (opts.before !== undefined && opts.before !== null) {
      params.push(opts.before);
      where.push(`seq < $${params.length}`);
    }
    if (opts.ref !== undefined) {
      params.push(opts.ref);
      where.push(`ref = $${params.length}`);
    }
    if (opts.type !== undefined) {
      params.push(opts.type);
      where.push(`type = $${params.length}`);
    }
    const res = await this.pool.query<AuditRow>(
      `SELECT seq, at, actor, type, ref, payload, prev_hash, hash FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT $1`,
      params,
    );
    return res.rows.map(toEvent);
  }
}
