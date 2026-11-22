import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Candidate } from '@tidepool/core';
import {
  InMemoryCandidateStore,
  PgCandidateSource,
  PgCandidateStore,
  type CandidateRow,
  type CandidateStore,
} from './candidates.js';
import { PgNarrativeStore } from './narrative.js';
import { PgSignalSink } from './sink.js';

const NOW = new Date('2026-11-22T12:00:00Z');

function cand(mint: string, score: number, expiresInMs: number, observedOffsetMs = 0): Candidate {
  const observedAt = new Date(NOW.getTime() - 10_000 + observedOffsetMs);
  return {
    mint,
    symbol: mint.toUpperCase(),
    pairAddress: `pair-${mint}`,
    score,
    features: {
      liquidityUsd: 50_000,
      volume5mUsd: 10_000,
      volumeTrend: 1.5,
      priceChange5mPct: 3,
      holderCount: 100,
      holderGrowth15m: 0.1,
      mentionVelocity: 0,
      sentiment: 0,
      narrativeLabel: null,
      narrativeScore: null,
      boosted: false,
    },
    safety: {
      mint,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      token2022Extensions: [],
      liquidityUsd: 50_000,
      top10HolderShare: 0.2,
      creatorFlagged: false,
      ageSeconds: 4_000,
      sellSimulationRatio: null,
    },
    reasons: ['scoring:test'],
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(NOW.getTime() + expiresInMs).toISOString(),
    priceUsd: 0.001,
  };
}

const rows: CandidateRow[] = [
  { candidate: cand('a', 60, 60_000), vetoReason: null },
  { candidate: cand('b', 90, 60_000), vetoReason: null },
  { candidate: cand('c', 95, 60_000), vetoReason: 'mint_authority_not_revoked' },
  { candidate: cand('d', 99, -1), vetoReason: null },
  { candidate: cand('e', 75, 60_000), vetoReason: null },
  { candidate: cand('f', 75, 60_000, 5_000), vetoReason: null },
];

async function contract(store: CandidateStore) {
  await store.upsertMany(rows);
  const top = await store.topCandidates(10, NOW);
  // Vetoed (c) and expired (d) rows are never served; ties break on the newer observation.
  expect(top.map((c) => c.mint)).toEqual(['b', 'f', 'e', 'a']);
  expect(top[0]).toEqual(rows[1]!.candidate);
  expect((await store.topCandidates(2, NOW)).map((c) => c.mint)).toEqual(['b', 'f']);
  expect(await store.topCandidates(0, NOW)).toEqual([]);

  // Upsert replaces in place, including a new veto.
  await store.upsertMany([{ candidate: { ...cand('b', 10, 60_000) }, vetoReason: 'cooldown_active' }]);
  expect((await store.topCandidates(10, NOW)).map((c) => c.mint)).toEqual(['f', 'e', 'a']);

  // At its expiry instant a row is no longer served, and deleteExpired removes it.
  expect((await store.topCandidates(10, new Date(NOW.getTime() + 60_000))).length).toBe(0);
  expect(await store.deleteExpired(NOW)).toBe(1);
  expect(await store.deleteExpired(new Date(NOW.getTime() + 60_000))).toBe(5);
}

describe('InMemoryCandidateStore', () => {
  it('serves unexpired, unvetoed candidates by score', async () => {
    await contract(new InMemoryCandidateStore());
  });

  it('reports only active cooldowns for the requested mode', async () => {
    const s = new InMemoryCandidateStore();
    s.cooldowns.set('a', { mode: 'paper', until: new Date(NOW.getTime() + 1_000) });
    s.cooldowns.set('b', { mode: 'live', until: new Date(NOW.getTime() + 1_000) });
    s.cooldowns.set('c', { mode: 'paper', until: new Date(NOW.getTime() - 1) });
    expect([...(await s.activeCooldowns('paper', ['a', 'b', 'c'], NOW)).keys()]).toEqual(['a']);
  });
});

const url = process.env.TEST_DATABASE_URL ?? 'postgres://memebot:memebot@127.0.0.1:5432/memebot_test';

async function tryConnect(): Promise<pg.Client | null> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

const client = await tryConnect();
const schema = `test_scout_${randomBytes(6).toString('hex')}`;

describe.skipIf(!client)('Postgres repositories (isolated schema)', () => {
  beforeAll(async () => {
    const sql = await readFile(new URL('../../../../db/migrations/001_init.sql', import.meta.url), 'utf8');
    await client!.query(`CREATE SCHEMA ${schema}`);
    await client!.query(`SET search_path TO ${schema}`);
    await client!.query(sql);
  });

  afterAll(async () => {
    await client!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client!.end();
  });

  it('PgCandidateStore orders, filters, upserts and expires like the in-memory store', async () => {
    await contract(new PgCandidateStore(client!));
  });

  it('PgCandidateSource skips rows whose stored JSON fails validation', async () => {
    await client!.query(
      `INSERT INTO candidates (mint, symbol, pair_address, score, price_usd, features, safety, reasons, observed_at, expires_at)
       VALUES ('bad', 'BAD', 'p', 99, 1, '{"liquidityUsd":"lots"}', '{}', '[]', $1, $2)`,
      [NOW.toISOString(), new Date(NOW.getTime() + 60_000).toISOString()],
    );
    await new PgCandidateStore(client!).upsertMany([{ candidate: cand('good', 50, 60_000), vetoReason: null }]);
    const top = await new PgCandidateSource(client!).topCandidates(10, NOW);
    expect(top.map((c) => c.mint)).toEqual(['good']);
  });

  it('reads active cooldowns per mode', async () => {
    await client!.query(
      `INSERT INTO cooldowns (mode, mint, until, reason) VALUES ('paper', 'x', $1, 'stop_loss'), ('live', 'y', $1, 'stop_loss'), ('paper', 'z', $2, 'stop_loss')`,
      [new Date(NOW.getTime() + 60_000).toISOString(), new Date(NOW.getTime() - 1).toISOString()],
    );
    const m = await new PgCandidateStore(client!).activeCooldowns('paper', ['x', 'y', 'z'], NOW);
    expect([...m.keys()]).toEqual(['x']);
  });

  it('PgSignalSink writes batches to signals', async () => {
    const sink = new PgSignalSink(client!, { batchSize: 2 });
    for (let i = 0; i < 5; i++)
      sink.emit({ source: 'dexscreener', mint: `m${i}`, kind: 'pair_snapshot', observedAt: NOW, payload: { i } });
    sink.emit({ source: 'helius', mint: null, kind: 'unresolved_tx', observedAt: NOW, payload: { signature: 's' } });
    await sink.flush();
    const { rows: r } = await client!.query(`SELECT source, mint, payload FROM signals ORDER BY id`);
    expect(r).toHaveLength(6);
    expect(r[5]).toMatchObject({ source: 'helius', mint: null, payload: { signature: 's' } });
  });

  it('PgSignalSink stores text with NUL, unpaired surrogates or bigint without stalling later batches', async () => {
    await client!.query('DELETE FROM signals');
    const sink = new PgSignalSink(client!, { batchSize: 2 });
    const cutEmoji = '\u{1F438}\u{1F438}'.slice(0, 3); // ends with an unpaired high surrogate
    sink.emit({
      source: 'x',
      mint: 'm1',
      kind: 'post',
      observedAt: NOW,
      payload: { text: `a\u0000b ${cutEmoji}`, lone: '\uDC00' },
    });
    sink.emit({ source: 'x', mint: 'm2', kind: 'post', observedAt: NOW, payload: { big: 1n } });
    sink.emit({ source: 'x', mint: 'm3', kind: 'post', observedAt: new Date(Number.NaN), payload: {} });
    sink.emit({ source: 'x', mint: 'm4', kind: 'post', observedAt: NOW, payload: { ok: true } });
    await sink.flush();
    expect(sink.bufferedCount).toBe(0);
    expect(sink.droppedCount).toBe(1);
    const { rows: r } = await client!.query(`SELECT mint, payload FROM signals ORDER BY id`);
    expect(r.map((x: { mint: string }) => x.mint)).toEqual(['m1', 'm2', 'm4']);
    expect(r[0].payload.text).toBe('ab \u{1F438}\uFFFD');
    expect(r[1].payload).toEqual({ unserializable: true, kind: 'post' });
  });

  it('PgCandidateStore stores metadata text that Postgres would otherwise reject', async () => {
    const c = cand('weird', 50, 60_000);
    const bad = { ...c, symbol: 'S\u0000Y', pairAddress: 'p\u0000', reasons: ['narrative_flag:\uD83D'] };
    await new PgCandidateStore(client!).upsertMany([{ candidate: bad, vetoReason: null }]);
    const top = await new PgCandidateSource(client!).topCandidates(10, NOW);
    const got = top.find((x) => x.mint === 'weird')!;
    expect(got.symbol).toBe('SY');
    expect(got.reasons).toEqual(['narrative_flag:\uFFFD']);
  });

  it('PgNarrativeStore upserts and reads back bounded scores', async () => {
    const s = new PgNarrativeStore(client!);
    await s.upsert('n1', { label: 'animal', score: 0.4, scamFlags: [], summary: 'dog' }, 'model-a', NOW);
    await s.upsert('n1', { label: 'other', score: 0.7, scamFlags: ['impersonation'], summary: 'x' }, 'model-a', NOW);
    const m = await s.getMany(['n1', 'missing']);
    expect(m.get('n1')).toEqual({ label: 'other', score: 0.7, scamFlags: ['impersonation'], scoredAt: NOW });
    expect(m.has('missing')).toBe(false);
  });
});
