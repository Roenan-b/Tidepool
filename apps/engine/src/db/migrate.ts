import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type pg from 'pg';
import { createPool } from './pool.js';

/** Repo-level db/migrations directory (same relative depth from src/db and dist/db). */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d+)_[A-Za-z0-9_-]+\.sql$/;
/** Arbitrary constant used to serialize concurrent migration runners against the same schema. */
const MIGRATION_LOCK_KEY = 7_420_001;

export interface MigrationResult { applied: string[]; skipped: string[] }

export async function listMigrations(dir: string): Promise<Array<{ version: string; file: string }>> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f));
  return files
    .map((file) => ({ version: file.replace(/\.sql$/, ''), file: join(dir, file), order: Number(MIGRATION_FILE.exec(file)![1]) }))
    .sort((a, b) => a.order - b.order || a.version.localeCompare(b.version))
    .map(({ version, file }) => ({ version, file }));
}

/**
 * Applies pending migrations in numeric order inside one transaction and records each in
 * schema_migrations. Idempotent: already-applied versions are skipped. Concurrent runners are
 * serialized with a transaction-scoped advisory lock keyed on the current schema.
 */
export async function runMigrations(pool: pg.Pool, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationResult> {
  const migrations = await listMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext(current_schema()))', [MIGRATION_LOCK_KEY]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const m of migrations) {
      if (done.has(m.version)) {
        skipped.push(m.version);
        continue;
      }
      const sql = await readFile(m.file, 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [m.version]);
      applied.push(m.version);
    }
    await client.query('COMMIT');
    return { applied, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(2);
  }
  const dir = process.env.MIGRATIONS_DIR || DEFAULT_MIGRATIONS_DIR;
  const pool = createPool(url, { max: 1, statementTimeoutMs: 120_000, applicationName: 'tidepool-migrate' });
  try {
    const res = await runMigrations(pool, dir);
    process.stdout.write(`migrations applied: ${res.applied.length ? res.applied.join(', ') : 'none'}; already applied: ${res.skipped.length}\n`);
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
