/**
 * PgOrderRepository against the local test database, in an isolated schema that is dropped afterwards.
 * Skips when the database is unreachable.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryOrderRepository, PgOrderRepository } from './orders.js';
import { MINT_A } from './testkit.js';
import type { NewOrder } from './types.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://memebot:memebot@127.0.0.1:5432/memebot_test';
const schema = `test_orders_${randomBytes(6).toString('hex')}`;
const migration = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../db/migrations/001_init.sql');

let client: pg.Client | null = null;
async function connect(): Promise<pg.Client | null> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await c.connect();
    return c;
  } catch {
    return null;
  }
}

const order = (over: Partial<NewOrder> = {}): NewOrder => ({
  id: randomUUID(),
  mode: 'paper',
  side: 'buy',
  mint: MINT_A,
  reservationId: null,
  positionId: null,
  signalAt: new Date('2026-11-01T00:00:00Z'),
  configVersion: 'momentum-v1@1.0.0/balanced/x',
  lamports: 499_495_000n,
  tokenAmount: null,
  ...over,
});

beforeAll(async () => {
  client = await connect();
  if (!client) return;
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(await readFile(migration, 'utf8'));
});

afterAll(async () => {
  if (!client) return;
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  await client.end();
});

describe('PgOrderRepository', () => {
  it('writes the built -> submitted -> landed lifecycle with timestamps', async (ctx) => {
    if (!client) return ctx.skip();
    const repo = new PgOrderRepository(client);
    const o = order();
    await repo.create(o);
    await repo.markSubmitted(o.id, new Date('2026-11-01T00:00:01Z'));
    await repo.markLanded(o.id, {
      at: new Date('2026-11-01T00:00:02Z'),
      signature: null,
      lamports: 500_000_000n,
      tokenAmount: 123_456_789_012_345_678n,
      feeLamports: 505_000n,
    });
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1', [o.id]);
    expect(rows[0]).toMatchObject({
      status: 'landed',
      side: 'buy',
      mode: 'paper',
      lamports: '500000000',
      token_amount: '123456789012345678',
      fee_lamports: '505000',
    });
    expect((rows[0].signal_at as Date).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect((rows[0].submitted_at as Date).toISOString()).toBe('2026-11-01T00:00:01.000Z');
    expect((rows[0].landed_at as Date).toISOString()).toBe('2026-11-01T00:00:02.000Z');
  });

  it('records failures and refuses illegal transitions', async (ctx) => {
    if (!client) return ctx.skip();
    const repo = new PgOrderRepository(client);
    const o = order({ side: 'sell', tokenAmount: 1000n, lamports: null });
    await repo.create(o);
    await repo.markSubmitted(o.id, new Date());
    await repo.markFailed(o.id, { at: new Date(), error: 'x'.repeat(900), feeLamports: 505_000n });
    const { rows } = await client.query('SELECT status, error, landed_at, fee_lamports FROM orders WHERE id = $1', [
      o.id,
    ]);
    expect(rows[0].status).toBe('failed');
    expect((rows[0].error as string).length).toBe(500);
    expect(rows[0].landed_at).toBeNull();
    await expect(
      repo.markLanded(o.id, { at: new Date(), signature: null, lamports: 1n, tokenAmount: null, feeLamports: 0n }),
    ).rejects.toThrow(/expected one row/);
    await expect(repo.markSubmitted(randomUUID(), new Date())).rejects.toThrow(/expected one row/);
  });
});

describe('InMemoryOrderRepository', () => {
  it('enforces the same transitions', async () => {
    const repo = new InMemoryOrderRepository();
    const o = order();
    await repo.create(o);
    await expect(repo.create(o)).rejects.toThrow();
    await repo.markSubmitted(o.id, new Date());
    await repo.markFailed(o.id, { at: new Date(), error: 'e', feeLamports: 1n });
    await expect(
      repo.markLanded(o.id, { at: new Date(), signature: null, lamports: 1n, tokenAmount: null, feeLamports: 0n }),
    ).rejects.toThrow();
  });
});
