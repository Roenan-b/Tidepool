import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPool } from './pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from './migrate.js';

export const DEFAULT_TEST_DATABASE_URL = 'postgres://memebot:memebot@127.0.0.1:5432/memebot_test';

export interface TestSchema {
  /** Pool whose every connection has search_path set to the isolated schema. */
  pool: pg.Pool;
  schema: string;
  url: string;
  /** Opens an extra pool on the same schema (for example to simulate a second process). */
  extraPool(max?: number): pg.Pool;
  /** Ends all pools and drops the schema. Safe to call twice. */
  dispose(): Promise<void>;
}

/**
 * Creates an isolated schema in the test database, points every pooled connection at it via the
 * libpq `options` startup parameter, and applies all migrations. Intended for vitest beforeAll.
 */
export async function createTestSchema(opts: { url?: string; max?: number; migrationsDir?: string } = {}): Promise<TestSchema> {
  const url = opts.url ?? process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  const schema = `test_${randomBytes(6).toString('hex')}`;
  const admin = createPool(url, { max: 1, applicationName: 'tidepool-test-admin' });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pools: pg.Pool[] = [];
  const make = (max: number) => {
    const p = createPool(url, { max, options: `-c search_path=${schema}`, applicationName: 'tidepool-test', connectionTimeoutMs: 120_000, statementTimeoutMs: 60_000 });
    pools.push(p);
    return p;
  };
  const pool = make(opts.max ?? 10);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  };
  try {
    await runMigrations(pool, opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR);
  } catch (err) {
    await dispose();
    throw err;
  }
  return { pool, schema, url, extraPool: (max = 5) => make(max), dispose };
}

/** Runs `fn` against a fresh isolated schema and always drops it afterwards. */
export async function withTestSchema<T>(fn: (t: TestSchema) => Promise<T>, opts?: Parameters<typeof createTestSchema>[0]): Promise<T> {
  const t = await createTestSchema(opts);
  try {
    return await fn(t);
  } finally {
    await t.dispose();
  }
}
