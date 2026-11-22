import pg from 'pg';
import type { Logger } from '../log.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: a pool or a client checked out inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface CreatePoolOptions {
  max?: number;
  /** Extra libpq startup options, for example `-c search_path=test_abc`. */
  options?: string;
  statementTimeoutMs?: number;
  /** Max wait for a connection, including waiting in the pool queue. */
  connectionTimeoutMs?: number;
  logger?: Logger;
  applicationName?: string;
}

/**
 * Creates a pg pool with conservative timeouts. int8 and numeric columns are returned as strings
 * by pg; callers convert them to bigint explicitly (no global type parsers, so other modules
 * sharing the process are unaffected).
 */
export function createPool(url: string, opts: CreatePoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectionTimeoutMs ?? 10_000,
    statement_timeout: opts.statementTimeoutMs ?? 15_000,
    application_name: opts.applicationName ?? 'tidepool-engine',
    ...(opts.options ? { options: opts.options } : {}),
  });
  pool.on('error', (err) => {
    // An idle client errored (for example the server restarted). Log and let the pool replace it.
    opts.logger?.error({ err: { message: err.message } }, 'postgres pool client error');
  });
  return pool;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/** Runs `fn` inside BEGIN/COMMIT on a dedicated client, retrying on serialization failures and deadlocks. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
  attempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (attempt < attempts && code && RETRYABLE.has(code)) continue;
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Converts a pg int8/numeric value (string, number or null) to bigint. */
export function toBig(v: unknown): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new TypeError(`non-integer numeric value: ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- error text for an unexpected value
  throw new TypeError(`cannot convert value to bigint: ${String(v)}`);
}

export function toBigOrNull(v: unknown): bigint | null {
  return v === null || v === undefined ? null : toBig(v);
}
