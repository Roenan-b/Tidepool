import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestSchema, type TestSchema } from '../db/testing.js';
import { PgAuditLog } from '../audit/pgAuditLog.js';
import { MemoryAlerter } from '../alerts/alerter.js';
import { PgRiskOfficer } from './pgRiskOfficer.js';
import { FakeClock, PresetBox, SOL, fakeMint, request, resetBook, testPreset, stateOf } from './testkit.js';

let db: TestSchema;
let clock: FakeClock;
let presets: PresetBox;
let audit: PgAuditLog;
let alerter: MemoryAlerter;
let solUsd: number | null;
let ro: PgRiskOfficer;

beforeAll(async () => {
  db = await createTestSchema({ max: 12 });
});
afterAll(async () => {
  await db?.dispose();
});

beforeEach(async () => {
  await resetBook(db.pool);
  clock = new FakeClock();
  presets = new PresetBox(testPreset());
  audit = new PgAuditLog({ pool: db.pool, clock });
  alerter = new MemoryAlerter();
  solUsd = null;
  ro = new PgRiskOfficer({
    pool: db.pool,
    audit,
    clock,
    mode: 'paper',
    preset: presets.resolver,
    solUsd: () => solUsd,
    alerter,
  });
  await ro.fundPaperPool(10n * SOL);
  const s = await ro.start('balanced');
  expect(s.ok).toBe(true);
});

describe('reserve concurrency', () => {
  it('never over-allocates under 1,000 parallel reserve() calls', async () => {
    const mint = fakeMint();
    const each = SOL / 20n; // 0.05 SOL
    // free cash = 10 SOL - 0.1 SOL fee reserve = 9.9 SOL -> exactly 198 fit
    const reqs = Array.from({ length: 1000 }, () => request(mint, each, clock));
    const decisions = await Promise.all(reqs.map((r) => ro.reserve(r)));
    const approved = decisions.filter((d) => d.approved);
    expect(approved).toHaveLength(198);
    for (const d of decisions) if (!d.approved) expect(d.reason).toBe('insufficient_free_cash');

    const held = await db.pool.query<{ s: string; n: string }>(
      `SELECT coalesce(sum(lamports),0)::text AS s, count(*)::text AS n FROM reservations WHERE status = 'held'`,
    );
    expect(BigInt(held.rows[0]!.s)).toBe(198n * each);
    expect(BigInt(held.rows[0]!.s)).toBeLessThanOrEqual(10n * SOL - presets.current.limits.feeReserveLamports);

    // Idempotent replay returns the same reservation for an approved key and the same veto for a vetoed key.
    const idx = decisions.findIndex((d) => d.approved);
    const replay = await ro.reserve(reqs[idx]!);
    const first = decisions[idx]!;
    expect(replay.approved && first.approved && replay.reservationId === first.reservationId).toBe(true);
    const vIdx = decisions.findIndex((d) => !d.approved);
    const vReplay = await ro.reserve(reqs[vIdx]!);
    expect(vReplay).toEqual({ approved: false, reason: 'insufficient_free_cash' });
    const count = await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM reservations`);
    expect(Number(count.rows[0]!.n)).toBe(198);

    // Every decision was audited and the chain is intact.
    const ev = await db.pool.query<{ type: string; n: string }>(
      `SELECT type, count(*)::text AS n FROM audit_events WHERE type IN ('reservation_approved','reservation_vetoed') AND payload->>'mint' = $1 GROUP BY type`,
      [mint],
    );
    const byType = Object.fromEntries(ev.rows.map((r) => [r.type, Number(r.n)]));
    expect(byType.reservation_approved).toBe(198);
    expect(byType.reservation_vetoed).toBe(802);
    expect((await audit.verify()).ok).toBe(true);
  });

  it('is idempotent for concurrent duplicates of the same key', async () => {
    const r = request(fakeMint(), SOL / 10n, clock);
    const ds = await Promise.all(Array.from({ length: 20 }, () => ro.reserve(r)));
    const ids = new Set(ds.map((d) => (d.approved ? d.reservationId : 'veto')));
    expect(ids.size).toBe(1);
    expect(ids.has('veto')).toBe(false);
  });

  it('vetoes a reused key with different parameters', async () => {
    const r = request(fakeMint(), SOL / 10n, clock);
    expect((await ro.reserve(r)).approved).toBe(true);
    expect(await ro.reserve({ ...r, lamports: SOL / 5n })).toEqual({
      approved: false,
      reason: 'idempotency_key_conflict',
    });
  });
});

describe('reserve limits', () => {
  it('vetoes when the engine is paused, stopped or halted', async () => {
    const mint = fakeMint();
    await ro.pause();
    expect(await ro.reserve(request(mint, SOL / 10n, clock))).toEqual({ approved: false, reason: 'engine_paused' });
    await ro.stop();
    expect(await ro.reserve(request(mint, SOL / 10n, clock))).toEqual({ approved: false, reason: 'engine_stopped' });
    await ro.start('balanced');
    await ro.halt('stale_data', 'collector silent');
    expect(await ro.reserve(request(mint, SOL / 10n, clock))).toEqual({ approved: false, reason: 'halted:stale_data' });
    expect(alerter.alerts.some((a) => a.kind === 'halt' && a.haltReason === 'stale_data')).toBe(true);
  });

  it('max open positions counts open positions and held reservations', async () => {
    presets.current = testPreset({ limits: { maxOpenPositions: 2 } });
    const a = await ro.reserve(request(fakeMint(), SOL / 10n, clock));
    expect(a.approved).toBe(true);
    if (a.approved)
      await ro.recordFill({
        reservationId: a.reservationId,
        orderId: 'o1',
        mint: (await db.pool.query('SELECT mint FROM reservations WHERE id=$1', [a.reservationId])).rows[0].mint,
        symbol: 'A',
        strategy: 'momentum-v1',
        lamportsSpent: SOL / 10n,
        tokenAmount: 1000n,
        entryPriceUsd: 1,
        signature: null,
      });
    expect((await ro.reserve(request(fakeMint(), SOL / 10n, clock))).approved).toBe(true);
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock))).toEqual({
      approved: false,
      reason: 'max_open_positions',
    });
  });

  it('per-position cap', async () => {
    presets.current = testPreset({ limits: { maxPositionBps: 500 } }); // 0.5 SOL of 10 SOL
    expect((await ro.reserve(request(fakeMint(), SOL / 2n, clock))).approved).toBe(true);
    expect(await ro.reserve(request(fakeMint(), SOL / 2n + 1n, clock))).toEqual({
      approved: false,
      reason: 'max_position_size',
    });
  });

  it('per-token exposure cap', async () => {
    presets.current = testPreset({ limits: { maxPositionBps: 500, maxPerTokenBps: 600 } });
    const mint = fakeMint();
    expect((await ro.reserve(request(mint, SOL / 2n, clock))).approved).toBe(true);
    expect(await ro.reserve(request(mint, SOL / 2n, clock))).toEqual({ approved: false, reason: 'max_token_exposure' });
    expect((await ro.reserve(request(fakeMint(), SOL / 2n, clock))).approved).toBe(true);
  });

  it('sleeve headroom', async () => {
    await db.pool.query(`INSERT INTO sleeves (mode, name, alloc_bps) VALUES ('paper', 'alt', 500)`);
    expect((await ro.reserve(request(fakeMint(), (4n * SOL) / 10n, clock, { sleeve: 'alt' }))).approved).toBe(true);
    expect(await ro.reserve(request(fakeMint(), (2n * SOL) / 10n, clock, { sleeve: 'alt' }))).toEqual({
      approved: false,
      reason: 'sleeve_headroom',
    });
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock, { sleeve: 'nope' }))).toEqual({
      approved: false,
      reason: 'unknown_sleeve',
    });
  });

  it('fee reserve is never allocatable', async () => {
    presets.current = testPreset({ limits: { feeReserveLamports: 9n * SOL + SOL / 2n } }); // free = 0.5 SOL
    expect(await ro.reserve(request(fakeMint(), SOL / 2n + 1n, clock))).toEqual({
      approved: false,
      reason: 'insufficient_free_cash',
    });
    expect((await ro.reserve(request(fakeMint(), SOL / 2n, clock))).approved).toBe(true);
  });

  it('position share of liquidity (reported and estimated from SOL price)', async () => {
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock, { positionShareOfLiquidity: 0.02 }))).toEqual({
      approved: false,
      reason: 'liquidity_share',
    });
    solUsd = 2000; // 0.5 SOL = $1,000 vs $20,000 liquidity = 5%
    const r = request(fakeMint(), SOL / 2n, clock, { positionShareOfLiquidity: 0, safety: { liquidityUsd: 20_000 } });
    expect(await ro.reserve(r)).toEqual({ approved: false, reason: 'liquidity_share' });
    expect(
      await ro.reserve(
        request(fakeMint(), SOL / 2n, clock, { positionShareOfLiquidity: 0.001, safety: { liquidityUsd: 2_000_000 } }),
      ),
    ).toMatchObject({ approved: true });
  });

  it.each([
    [{ mintAuthorityRevoked: false }, 'safety:mint_authority'],
    [{ freezeAuthorityRevoked: false }, 'safety:freeze_authority'],
    [{ token2022Extensions: ['transferHook'] }, 'safety:token2022_extension:transferHook'],
    [{ token2022Extensions: ['permanentDelegate'] }, 'safety:token2022_extension:permanentDelegate'],
    [{ liquidityUsd: 19_999 }, 'safety:min_liquidity'],
    [{ top10HolderShare: 0.41 }, 'safety:top10_concentration'],
    [{ ageSeconds: 60 }, 'safety:too_new'],
    [{ ageSeconds: 30 * 86400 }, 'safety:too_old'],
    [{ sellSimulationRatio: 0.5 }, 'safety:sell_simulation'],
    [{ sellSimulationRatio: null }, 'safety:sell_simulation_missing'],
    [{ creatorFlagged: true }, 'safety:creator_flagged'],
    [{ liquidityUsd: Number.NaN }, 'safety:min_liquidity'],
  ] as const)('safety filter %o vetoes with %s', async (safety, reason) => {
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock, { safety: safety as never }))).toEqual({
      approved: false,
      reason,
    });
  });

  it('allowed Token-2022 extensions pass', async () => {
    expect(
      (
        await ro.reserve(
          request(fakeMint(), SOL / 10n, clock, { safety: { token2022Extensions: ['metadataPointer'] } }),
        )
      ).approved,
    ).toBe(true);
  });

  it('cooldown after a stop-loss exit', async () => {
    const mint = fakeMint();
    const d = await ro.reserve(request(mint, SOL / 10n, clock));
    if (!d.approved) throw new Error('expected approval');
    const { positionId } = await ro.recordFill({
      reservationId: d.reservationId,
      orderId: 'o',
      mint,
      symbol: 'X',
      strategy: 'momentum-v1',
      lamportsSpent: SOL / 10n,
      tokenAmount: 10n,
      entryPriceUsd: 1,
      signature: null,
    });
    await ro.recordExit({
      positionId,
      orderId: 'o2',
      lamportsReceived: SOL / 20n,
      reason: 'stop_loss',
      signature: null,
    });
    expect(await ro.reserve(request(mint, SOL / 10n, clock))).toEqual({ approved: false, reason: 'cooldown' });
    clock.advance(presets.current.filters.cooldownAfterStopSeconds * 1000 + 1);
    expect((await ro.reserve(request(mint, SOL / 10n, clock))).approved).toBe(true);
  });

  it('rejects expired candidates and malformed requests', async () => {
    const mint = fakeMint();
    const r = request(mint, SOL / 10n, clock);
    clock.advance(10 * 60_000);
    expect(await ro.reserve(r)).toEqual({ approved: false, reason: 'candidate_expired' });
    expect(await ro.reserve({ ...request(mint, 0n, clock) })).toEqual({
      approved: false,
      reason: 'invalid_request:lamports',
    });
    expect(await ro.reserve({ ...request(mint, SOL, clock), mint: 'not-a-mint' })).toEqual({
      approved: false,
      reason: 'invalid_request:mint',
    });
    expect(await ro.reserve({ ...request(mint, SOL, clock), positionShareOfLiquidity: Number.NaN })).toEqual({
      approved: false,
      reason: 'invalid_request:liquidity_share',
    });
  });

  it('expires stale reservations and frees their cash', async () => {
    presets.current = testPreset({ limits: { feeReserveLamports: 9n * SOL } }); // free = 1 SOL
    expect((await ro.reserve(request(fakeMint(), SOL, clock))).approved).toBe(true);
    expect((await ro.reserve(request(fakeMint(), SOL, clock))).approved).toBe(false);
    clock.advance(61_000);
    expect(await ro.expireStaleReservations()).toBe(1);
    expect((await ro.reserve(request(fakeMint(), SOL, clock))).approved).toBe(true);
    expect((await stateOf(db.pool, 'paper')).state).toBe('running');
  });
});
