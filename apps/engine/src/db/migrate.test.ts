import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, withTestSchema, type TestSchema } from './testing.js';
import { DEFAULT_MIGRATIONS_DIR, listMigrations, runMigrations } from './migrate.js';
import { toBig } from './pool.js';

let db: TestSchema;
beforeAll(async () => {
  db = await createTestSchema();
});
afterAll(async () => {
  await db?.dispose();
});

describe('migrations', () => {
  it('applied 001_init into the isolated schema and recorded it', async () => {
    const r = await db.pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(r.rows.map((x) => x.version)).toContain('001_init');
    const sp = await db.pool.query<{ search_path: string }>('SHOW search_path');
    expect(sp.rows[0]!.search_path).toBe(db.schema);
    const t = await db.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'pool_state'`, [db.schema]);
    expect(t.rowCount).toBe(1);
  });

  it('is idempotent, including concurrent runners', async () => {
    const results = await Promise.all([runMigrations(db.pool), runMigrations(db.pool), runMigrations(db.pool)]);
    for (const r of results) expect(r.applied).toEqual([]);
    const n = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM pool_state');
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it('applies files in numeric order and rolls back a failing batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tidepool-mig-'));
    try {
      await writeFile(join(dir, '010_b.sql'), 'CREATE TABLE mig_b (id int);');
      await writeFile(join(dir, '002_a.sql'), 'CREATE TABLE mig_a (id int);');
      await writeFile(join(dir, 'notes.txt'), 'ignored');
      expect((await listMigrations(dir)).map((m) => m.version)).toEqual(['002_a', '010_b']);
      await withTestSchema(async (t) => {
        await writeFile(join(dir, '011_bad.sql'), 'CREATE TABLE mig_c (id int); SELECT broken syntax here;');
        await expect(runMigrations(t.pool, dir)).rejects.toThrow();
        const none = await t.pool.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('mig_a','mig_c')`, [t.schema]);
        expect(none.rowCount).toBe(0);
        await rm(join(dir, '011_bad.sql'));
        expect((await runMigrations(t.pool, dir)).applied).toEqual(['002_a', '010_b']);
      }, { migrationsDir: DEFAULT_MIGRATIONS_DIR });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('withTestSchema drops the schema afterwards', async () => {
    let name = '';
    await withTestSchema(async (t) => {
      name = t.schema;
    });
    const r = await db.pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [name]);
    expect(r.rowCount).toBe(0);
  });

  it('toBig converts pg numeric strings strictly', () => {
    expect(toBig('-42')).toBe(-42n);
    expect(toBig(null)).toBe(0n);
    expect(() => toBig('1.5')).toThrow();
  });
});
