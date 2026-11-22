import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@solana/web3.js';
import { LIVE_MODE_CONFIRMATION, type PresetName, type TradingMode } from '@tidepool/core';
import type { AuditLog, EngineControl } from '../contracts.js';
import { createTestSchema, type TestSchema } from '../db/testing.js';
import { PgAuditLog } from '../audit/pgAuditLog.js';
import { PgRiskOfficer } from '../risk/pgRiskOfficer.js';
import { FakeClock, PresetBox, SOL, fakeMint, request, resetBook, testPreset } from '../risk/testkit.js';
import { buildControlApi, tokenMatches, TokenBucketLimiter } from './server.js';
import { PgQueries } from './queries.js';

const TOKEN = 'k'.repeat(64);

class FakeControl implements EngineControl {
  calls: string[] = [];
  failKill = false;
  async start(p: PresetName) {
    this.calls.push(`start:${p}`);
  }
  async pause() {
    this.calls.push('pause');
  }
  async killSwitch() {
    this.calls.push('kill');
    if (this.failKill) throw new Error('trader down');
    return { positionsClosing: 0 };
  }
}

let db: TestSchema;
let clock: FakeClock;
let audit: PgAuditLog;
let paper: PgRiskOfficer;
let live: PgRiskOfficer;
let queries: PgQueries;
let control: FakeControl;
let app: FastifyInstance;
let modeChanges: TradingMode[];

beforeAll(async () => {
  db = await createTestSchema();
});
afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

beforeEach(async () => {
  await resetBook(db.pool);
  clock = new FakeClock();
  const presets = new PresetBox(testPreset());
  audit = new PgAuditLog({ pool: db.pool, clock });
  const common = {
    pool: db.pool,
    audit,
    clock,
    preset: presets.resolver,
    config: { liveTradingEnabled: true, signerConfigured: true },
  };
  paper = new PgRiskOfficer({ ...common, mode: 'paper' });
  live = new PgRiskOfficer({ ...common, mode: 'live', ticketSecret: 's'.repeat(40) });
  queries = new PgQueries({
    pool: db.pool,
    audit,
    clock,
    preset: presets.resolver,
    liveTradingAllowed: true,
    stretchTargetUsd: 200,
    knownSignalSources: ['dexscreener'],
  });
  control = new FakeControl();
  modeChanges = [];
  await app?.close();
  app = buildControlApi({
    riskOfficer: (m) => (m === 'live' ? live : paper),
    control,
    queries,
    audit,
    config: { api: { token: TOKEN } },
    onModeChange: async (m) => {
      modeChanges.push(m);
    },
    rateLimit: { capacity: 5, refillPerSecond: 0.0001 },
  });
  await app.ready();
});

function call(
  method: 'GET' | 'POST',
  url: string,
  opts: { role?: string; token?: string | null; body?: unknown; user?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.user !== undefined) headers['x-actor-user'] = opts.user;
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.role !== undefined) headers['x-actor-role'] = opts.role;
  else headers['x-actor-role'] = 'owner';
  return app.inject({ method, url, headers, ...(opts.body !== undefined ? { payload: opts.body as object } : {}) });
}

describe('authentication', () => {
  it('rejects missing or wrong bearer tokens with 401', async () => {
    expect((await call('GET', '/status', { token: null })).statusCode).toBe(401);
    expect((await call('GET', '/status', { token: 'k'.repeat(63) })).statusCode).toBe(401);
    expect((await call('POST', '/control/kill', { token: 'wrong', body: { confirm: 'SELL_ALL' } })).statusCode).toBe(
      401,
    );
    expect(control.calls).toEqual([]);
  });

  it('requires a valid X-Actor-Role', async () => {
    expect((await call('GET', '/status', { role: 'admin' })).statusCode).toBe(403);
    expect((await call('GET', '/status', { role: '' })).statusCode).toBe(403);
  });

  it('compares tokens in constant time over hashes', () => {
    expect(tokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false);
    expect(tokenMatches('Bearer ', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it('refuses to build with a short token', () => {
    expect(() =>
      buildControlApi({ riskOfficer: paper, control, queries, audit, config: { api: { token: 'short' } } }),
    ).toThrow();
  });
});

describe('reads', () => {
  it('GET /status returns lamports as strings', async () => {
    await paper.fundPaperPool(10n * SOL);
    const res = await call('GET', '/status', { role: 'operator' });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s).toMatchObject({ mode: 'paper', state: 'stopped', preset: 'balanced', liveTradingAllowed: true });
    expect(s.pool.equityLamports).toBe('10000000000');
    expect(s.pool.cashLamports).toBe((10n * SOL - 100_000_000n).toString());
    expect(s.today.lossLimitLamports).toBe('10000000000');
  });

  it('GET /positions, /candidates, /events, /metrics, /signals', async () => {
    await paper.fundPaperPool(10n * SOL);
    await paper.start('balanced');
    const mint = fakeMint();
    const d = await paper.reserve(request(mint, SOL / 10n, clock));
    if (!d.approved) throw new Error('vetoed');
    const { positionId } = await paper.recordFill({
      reservationId: d.reservationId,
      orderId: 'o',
      mint,
      symbol: 'ABC',
      strategy: 'momentum-v1',
      lamportsSpent: SOL / 10n,
      tokenAmount: 5n,
      entryPriceUsd: 1,
      signature: null,
    });
    await paper.markPositions([{ positionId, markLamports: SOL / 5n }]);
    await db.pool.query(
      `INSERT INTO orders (id, mode, side, mint, status, signal_at, submitted_at, created_at) VALUES
        (gen_random_uuid(), 'paper', 'buy', $1, 'landed', $2, $3, $3), (gen_random_uuid(), 'paper', 'buy', $1, 'failed', $2, $4, $4)`,
      [
        mint,
        new Date(clock.now().getTime() - 1000),
        new Date(clock.now().getTime() - 800),
        new Date(clock.now().getTime() - 600),
      ],
    );
    await db.pool.query(
      `INSERT INTO signals (source, mint, kind, observed_at, payload) VALUES ('dexscreener', $1, 'pair', $2, '{"x":1}')`,
      [mint, new Date(clock.now().getTime() - 5000)],
    );
    await db.pool.query(
      `INSERT INTO candidates (mint, symbol, pair_address, score, price_usd, features, safety, reasons, observed_at, expires_at)
       VALUES ($1, 'ABC', $1, 77, 0.01, '{"liquidityUsd": 50000, "mentionVelocity": 1.5, "sentiment": 0.2, "narrativeLabel": "cats"}', '{}', '["trend"]', $2, $3)`,
      [mint, clock.now(), new Date(clock.now().getTime() + 60_000)],
    );
    await paper.reconcile();
    await queries.refreshAuditValidity();

    const pos = (await call('GET', '/positions?status=open&limit=10')).json();
    expect(pos).toHaveLength(1);
    expect(pos[0]).toMatchObject({
      symbol: 'ABC',
      entryLamports: '100000000',
      markLamports: '200000000',
      unrealizedPnlLamports: '100000000',
    });
    expect((await call('GET', '/positions?status=closed')).json()).toEqual([]);
    expect((await call('GET', '/positions?status=all')).json()).toHaveLength(1);
    expect((await call('GET', '/positions?status=bogus')).statusCode).toBe(400);

    const cands = (await call('GET', '/candidates')).json();
    expect(cands[0]).toMatchObject({ symbol: 'ABC', liquidityUsd: 50000, narrativeLabel: 'cats', reasons: ['trend'] });

    const events = (await call('GET', '/events?limit=3')).json();
    expect(events).toHaveLength(3);
    const older = (await call('GET', `/events?limit=2&before=${events[2].seq}`)).json();
    expect(older[0].seq).toBeLessThan(events[2].seq);
    const olderByAlias = (await call('GET', `/events?limit=2&beforeSeq=${events[2].seq}`)).json();
    expect(olderByAlias).toEqual(older);

    const m = (await call('GET', '/metrics')).json();
    expect(m.latencyMs.signalToSubmit.p50).toBe(200);
    expect(m.landingRate).toBe(0.5);
    expect(m.dataFreshnessSeconds.dexscreener).toBe(5);
    expect(m.reconciliation.ok).toBe(true);
    expect(m.auditChainValid).toBe(true);

    const sig = (await call('GET', '/signals?limit=5')).json();
    expect(sig[0]).toMatchObject({ source: 'dexscreener', kind: 'pair' });
    expect((await call('GET', '/signals?limit=0')).statusCode).toBe(400);
    expect((await call('GET', '/signals?source=dexscreener')).json()).toHaveLength(1);
    expect((await call('GET', '/signals?source=helius')).json()).toEqual([]);
    expect((await call('GET', '/signals?source=Bad%20Source')).statusCode).toBe(400);
  });

  it('returns 404 without detail for unknown routes', async () => {
    const r = await call('GET', '/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not found' });
  });
});

describe('controls', () => {
  it('start, pause and kill drive both the Risk Officer and the engine control', async () => {
    await paper.fundPaperPool(SOL);
    expect((await call('POST', '/control/start', { body: { preset: 'balanced' } })).json()).toMatchObject({
      ok: true,
      state: 'running',
    });
    expect((await call('POST', '/control/pause', { role: 'operator' })).json()).toMatchObject({
      ok: true,
      state: 'paused',
    });
    const kill = await call('POST', '/control/kill', { body: { confirm: 'SELL_ALL' } });
    expect(kill.statusCode).toBe(200);
    expect(control.calls).toEqual(['start:balanced', 'pause', 'kill']);
    expect((await call('POST', '/control/start', { body: { preset: 'balanced' } })).statusCode).toBe(409);
    const audits = await db.pool.query<{ actor: string; route: string; status: number }>(
      `SELECT actor, payload->>'route' AS route, (payload->>'status')::int AS status FROM audit_events WHERE type = 'control_api_request' ORDER BY seq`,
    );
    expect(audits.rows).toEqual([
      { actor: 'owner', route: '/control/start', status: 200 },
      { actor: 'operator', route: '/control/pause', status: 200 },
      { actor: 'owner', route: '/control/kill', status: 200 },
      { actor: 'owner', route: '/control/start', status: 409 },
    ]);
  });

  it('records the dashboard username in the audit trail and ignores malformed ones', async () => {
    await paper.fundPaperPool(SOL);
    await call('POST', '/control/start', { body: { preset: 'balanced' }, user: 'jake' });
    await call('POST', '/control/pause', { role: 'operator', user: 'bad user\u0000' });
    const audits = await db.pool.query<{ actor: string; usr: string | null }>(
      `SELECT actor, payload->>'actorUser' AS usr FROM audit_events WHERE type = 'control_api_request' ORDER BY seq`,
    );
    expect(audits.rows.slice(-2)).toEqual([
      { actor: 'owner', usr: 'jake' },
      { actor: 'operator', usr: null },
    ]);
  });

  it('validates bodies against the core schemas', async () => {
    expect((await call('POST', '/control/start', { body: { preset: 'yolo' } })).statusCode).toBe(400);
    expect((await call('POST', '/control/kill', { body: { confirm: 'yes' } })).statusCode).toBe(400);
    expect((await call('POST', '/control/kill', {})).statusCode).toBe(400);
    expect((await call('POST', '/wallet/withdraw', { body: { lamports: '-5' } })).statusCode).toBe(400);
    expect((await call('POST', '/wallet/withdraw', { body: { lamports: '0' } })).statusCode).toBe(400);
    expect((await call('POST', '/control/clear-halt', { role: 'operator', body: { reason: 'x' } })).statusCode).toBe(
      400,
    );
    const bad = await app.inject({
      method: 'POST',
      url: '/control/start',
      headers: { authorization: `Bearer ${TOKEN}`, 'x-actor-role': 'owner', 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).not.toMatch(/at .*\.ts|stack/i);
    expect(control.calls).toEqual([]);
  });

  it('reports a kill switch the trader did not acknowledge', async () => {
    control.failKill = true;
    const r = await call('POST', '/control/kill', { body: { confirm: 'SELL_ALL' } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/kill switch recorded/);
    expect((await queries.status()).haltReason).toBe('kill_switch');
  });

  it('enforces roles: live mode owner only, clear-halt operator only, wallet owner only', async () => {
    expect(
      (
        await call('POST', '/control/mode', {
          role: 'operator',
          body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', '/control/mode', { role: 'owner', body: { mode: 'live', confirm: 'nope' } })).json(),
    ).toEqual({ error: 'confirmation_required' });
    const ok = await call('POST', '/control/mode', {
      role: 'owner',
      body: { mode: 'live', confirm: LIVE_MODE_CONFIRMATION },
    });
    expect(ok.json()).toEqual({ ok: true, mode: 'live' });
    expect(modeChanges).toEqual(['live']);
    expect((await call('POST', '/control/mode', { role: 'operator', body: { mode: 'paper' } })).json()).toEqual({
      ok: true,
      mode: 'paper',
    });

    await paper.halt('manual', 'test');
    expect(
      (await call('POST', '/control/clear-halt', { role: 'owner', body: { reason: 'looks fine' } })).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', '/control/clear-halt', { role: 'operator', body: { reason: 'looks fine' } })).json(),
    ).toMatchObject({ ok: true, state: 'paused' });

    const addr = Keypair.generate().publicKey.toBase58();
    expect(
      (await call('POST', '/wallet/withdraw-address', { role: 'operator', body: { address: addr } })).statusCode,
    ).toBe(403);
    expect((await call('POST', '/wallet/withdraw', { role: 'operator', body: { lamports: '1' } })).statusCode).toBe(
      403,
    );
  });

  it('wallet happy path for the owner', async () => {
    await paper.fundPaperPool(2n * SOL);
    const addr = Keypair.generate().publicKey.toBase58();
    expect((await call('POST', '/wallet/withdraw', { body: { lamports: '1000' } })).json()).toEqual({
      error: 'no_withdraw_address',
    });
    expect((await call('POST', '/wallet/withdraw-address', { body: { address: addr } })).json()).toMatchObject({
      ok: true,
      status: 'active',
      address: addr,
    });
    expect((await call('POST', '/wallet/withdraw-address', { body: { address: '1'.repeat(40) } })).statusCode).toBe(
      400,
    );
    const w = await call('POST', '/wallet/withdraw', { body: { lamports: SOL.toString() } });
    expect(w.json()).toMatchObject({ ok: true, lamports: SOL.toString(), destination: addr, requiresSigner: false });
    expect((await queries.status()).wallet.withdrawAddress).toBe(addr);
  });

  it('rate-limits mutating routes per role', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await call('POST', '/control/pause', { role: 'operator' })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 409 || c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
    // Reads are not rate-limited.
    for (let i = 0; i < 10; i++) expect((await call('GET', '/status')).statusCode).toBe(200);
  });
});

describe('with fakes', () => {
  it('works with an in-memory read model and audit log', async () => {
    const appended: unknown[] = [];
    const fakeAudit: AuditLog = {
      append: async (e) => {
        appended.push(e);
        return { seq: appended.length, hash: 'h' };
      },
      verify: async () => ({ ok: true, brokenAt: null, checked: 0 }),
    };
    const fakeQueries = {
      activeMode: async () => 'paper' as const,
      status: async () => ({ mode: 'paper' }) as never,
      positions: async () => [],
      candidates: async () => [],
      events: async () => [],
      metrics: async () => ({}) as never,
      signals: async () => [],
    };
    const officer = {
      mode: () => 'paper' as const,
      start: async () => ({ ok: true as const, state: 'running' as const, haltReason: null }),
      pause: async () => ({ ok: false as const, reason: 'halted:manual' }),
      killSwitch: async () => ({ positionsClosing: 3, reservationsReleased: 1 }),
      clearHalt: async () => ({ ok: true as const, state: 'paused' as const, haltReason: null }),
      setMode: async () => ({ ok: true as const, mode: 'paper' as const }),
      setWithdrawAddress: async (a: string) => ({ status: 'pending' as const, address: a, effectiveAt: new Date(0) }),
      requestWithdrawal: async () => ({ ok: false as const, reason: 'insufficient_free_cash' }),
    };
    const a = buildControlApi({
      riskOfficer: officer,
      control: new FakeControl(),
      queries: fakeQueries,
      audit: fakeAudit,
      config: { api: { token: TOKEN } },
    });
    const h = { authorization: `Bearer ${TOKEN}`, 'x-actor-role': 'owner' };
    expect(
      (await a.inject({ method: 'POST', url: '/control/kill', headers: h, payload: { confirm: 'SELL_ALL' } })).json(),
    ).toEqual({ ok: true, positionsClosing: 3, reservationsReleased: 1 });
    expect((await a.inject({ method: 'POST', url: '/control/pause', headers: h })).statusCode).toBe(409);
    expect(
      (await a.inject({ method: 'POST', url: '/wallet/withdraw', headers: h, payload: { lamports: '5' } })).json(),
    ).toEqual({ error: 'insufficient_free_cash' });
    expect(appended).toHaveLength(3);
    await a.close();
  });
});

describe('TokenBucketLimiter', () => {
  it('refills over time', () => {
    let t = 0;
    const l = new TokenBucketLimiter(2, 1, () => t);
    expect([l.take('a'), l.take('a'), l.take('a')]).toEqual([true, true, false]);
    t += 1000;
    expect(l.take('a')).toBe(true);
    expect(l.take('b')).toBe(true);
  });

  it('keeps working after the wall clock steps backwards', () => {
    let t = 10_000_000;
    const l = new TokenBucketLimiter(2, 1, () => t);
    expect([l.take('kill'), l.take('kill')]).toEqual([true, true]);
    t -= 3_600_000; // clock stepped back one hour
    expect(l.take('kill')).toBe(false);
    t += 1000; // one second later on the new timeline the bucket refills as usual
    expect(l.take('kill')).toBe(true);
  });
});
