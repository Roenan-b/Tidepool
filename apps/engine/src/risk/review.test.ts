/**
 * Regression tests for defects found in the Risk Officer review. Each test fails on the code as it
 * was before the corresponding fix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { LIVE_MODE_CONFIRMATION } from '@tidepool/core';
import { createTestSchema, type TestSchema } from '../db/testing.js';
import { createPool } from '../db/pool.js';
import { PgAuditLog } from '../audit/pgAuditLog.js';
import { MemoryAlerter } from '../alerts/alerter.js';
import { PgRiskOfficer, cleanSymbol, type RiskOfficerSettings } from './pgRiskOfficer.js';
import { tokenSafetyVeto } from './safety.js';
import { candidate } from './testkit.js';
import { FakeClock, PresetBox, SOL, cashOf, fakeMint, ledgerSum, request, resetBook, stateOf, testPreset } from './testkit.js';

const SECRET = 'z'.repeat(48);
let db: TestSchema;
let clock: FakeClock;
let presets: PresetBox;
let audit: PgAuditLog;
let alerter: MemoryAlerter;

beforeAll(async () => {
  db = await createTestSchema();
});
afterAll(async () => {
  await db?.dispose();
});

beforeEach(async () => {
  await resetBook(db.pool);
  clock = new FakeClock('2026-11-22T10:00:00.000Z');
  presets = new PresetBox(testPreset());
  audit = new PgAuditLog({ pool: db.pool, clock });
  alerter = new MemoryAlerter();
});

function officer(mode: 'paper' | 'live', config: Partial<RiskOfficerSettings> = {}, pool = db.pool): PgRiskOfficer {
  return new PgRiskOfficer({
    pool, audit: pool === db.pool ? audit : new PgAuditLog({ pool, clock }), clock, mode, preset: presets.resolver, alerter,
    ticketSecret: mode === 'live' ? SECRET : null,
    config: { liveTradingEnabled: true, signerConfigured: true, ...config },
  });
}

async function goLive(): Promise<PgRiskOfficer> {
  expect(await officer('paper').setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: true, mode: 'live' });
  return officer('live');
}

const addr = () => Keypair.generate().publicKey.toBase58();

describe('idempotent replay never re-issues a settled reservation', () => {
  it('a key whose reservation the kill switch released is vetoed, not re-approved with a fresh ticket', async () => {
    const live = await goLive();
    await live.bookDeposit(10n * SOL, '4'.repeat(88));
    await live.start('balanced');
    const req = request(fakeMint(), SOL / 10n, clock);
    const first = await live.reserve(req);
    expect(first.approved).toBe(true);
    await live.killSwitch('owner');
    clock.advance(1_000); // the original ticket would still be valid at the signer
    const replay = await live.reserve(req);
    expect(replay).toEqual({ approved: false, reason: 'reservation_released' });
  });

  it('a key whose reservation was already filled is vetoed, so a retried buy cannot go unbooked', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const mint = fakeMint();
    const req = request(mint, SOL / 10n, clock);
    const d = await ro.reserve(req);
    if (!d.approved) throw new Error('vetoed');
    await ro.recordFill({ reservationId: d.reservationId, orderId: 'o', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: SOL / 10n, tokenAmount: 1n, entryPriceUsd: 1, signature: null });
    expect(await ro.reserve(req)).toEqual({ approved: false, reason: 'reservation_filled' });
  });

  it('a key whose reservation expired is vetoed even before the sweeper runs', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const req = request(fakeMint(), SOL / 10n, clock, {});
    req.candidate.expiresAt = new Date(clock.now().getTime() + 3600_000).toISOString();
    expect((await ro.reserve(req)).approved).toBe(true);
    clock.advance(61_000);
    expect(await ro.reserve(req)).toEqual({ approved: false, reason: 'reservation_expired' });
    const held = await db.pool.query(`SELECT 1 FROM reservations WHERE status = 'held'`);
    expect(held.rowCount).toBe(0);
  });
});

describe('live holds outlive their tickets by the landing grace', () => {
  it('keeps the funds held after the ticket expires until a late landing is no longer possible', async () => {
    presets.current = testPreset({ limits: { feeReserveLamports: 9n * SOL } }); // free = 1 SOL
    const live = await goLive();
    await live.bookDeposit(10n * SOL, '3'.repeat(88));
    await live.start('balanced');
    const req = request(fakeMint(), SOL, clock);
    req.candidate.expiresAt = new Date(clock.now().getTime() + 3600_000).toISOString();
    const d = await live.reserve(req);
    if (!d.approved || !d.ticket) throw new Error('expected a ticket');
    expect(d.expiresAt.getTime()).toBe(clock.now().getTime() + 60_000);
    expect(d.ticket.ticket.expiresAt).toBe(d.expiresAt.getTime());
    clock.advance(61_000); // ticket expired; a transaction signed at 59 s may still land
    expect(await live.expireStaleReservations()).toBe(0);
    const second = request(fakeMint(), SOL, clock);
    second.candidate.expiresAt = new Date(clock.now().getTime() + 3600_000).toISOString();
    expect(await live.reserve(second)).toEqual({ approved: false, reason: 'insufficient_free_cash' });
    expect(await live.reserve(req)).toEqual({ approved: false, reason: 'reservation_expired' });
    clock.advance(90_000);
    expect(await live.expireStaleReservations()).toBe(1);
  });
});

describe('kill switch keeps withdrawal holds', () => {
  it('does not free SOL that a signed withdrawal ticket may still move', async () => {
    const live = await goLive();
    await live.bookDeposit(3n * SOL, '2'.repeat(88));
    expect((await live.setWithdrawAddress(addr())).status).toBe('pending');
    clock.advance(24 * 3600_000 + 1);
    const w = await live.requestWithdrawal(2n * SOL);
    expect(w.ok).toBe(true);
    const k = await live.killSwitch('owner');
    expect(k.reservationsReleased).toBe(0);
    const held = await db.pool.query<{ status: string }>(`SELECT status FROM reservations WHERE sleeve = '__withdrawal'`);
    expect(held.rows.map((r) => r.status)).toEqual(['held']);
    // The same SOL cannot be authorized a second time.
    expect(await live.requestWithdrawal(2n * SOL)).toEqual({ ok: false, reason: 'insufficient_free_cash' });
  });
});

describe('withdrawal address timelock', () => {
  it('an address set instantly in paper mode cannot be used for a live withdrawal before the timelock', async () => {
    const paper = officer('paper');
    const a = addr();
    expect((await paper.setWithdrawAddress(a)).status).toBe('active');
    const live = await goLive();
    await live.bookDeposit(3n * SOL, '1'.repeat(88));
    expect(await live.requestWithdrawal(SOL)).toEqual({ ok: false, reason: 'withdraw_address_timelocked' });
    clock.advance(24 * 3600_000);
    expect(await live.requestWithdrawal(SOL)).toMatchObject({ ok: true, destination: a });
  });

  it('an address whose provenance is unknown is refused in live mode', async () => {
    const live = await goLive();
    await live.bookDeposit(3n * SOL, 'A'.repeat(88));
    await db.pool.query('UPDATE settings SET withdraw_address = $1', [addr()]);
    expect(await live.requestWithdrawal(SOL)).toEqual({ ok: false, reason: 'withdraw_address_timelocked' });
  });

  it('an address activated through the timelock works at once, also on a later request', async () => {
    const live = await goLive();
    await live.bookDeposit(3n * SOL, 'B'.repeat(88));
    const a = addr();
    await live.setWithdrawAddress(a);
    clock.advance(24 * 3600_000);
    expect(await live.promotePendingWithdrawAddress()).toBe(true);
    expect(await live.requestWithdrawal(SOL / 2n)).toMatchObject({ ok: true, destination: a });
  });
});

describe('daily loss limit across the UTC day boundary', () => {
  it('a loss first observed by the first mark of a new day counts against that day', async () => {
    presets.current = testPreset({ limits: { dailyLossLimitBps: 400, maxDrawdownBps: 9000 } }); // 0.4 SOL of 10
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const d = await ro.reserve(request(fakeMint(), SOL, clock));
    if (!d.approved) throw new Error('vetoed');
    const mint = (await db.pool.query<{ mint: string }>('SELECT mint FROM reservations WHERE id = $1', [d.reservationId])).rows[0]!.mint;
    const { positionId } = await ro.recordFill({ reservationId: d.reservationId, orderId: 'b', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: SOL, tokenAmount: 1n, entryPriceUsd: 1, signature: null });
    await ro.markPositions([{ positionId, markLamports: SOL }]);
    clock.set('2026-11-23T00:00:05.000Z');
    await ro.markPositions([{ positionId, markLamports: SOL / 2n }]); // -0.5 SOL, over the 0.4 SOL limit
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'halted', reason: 'daily_loss_limit' });
  });

  it('does not re-roll the day on every touch when the session DateStyle is not ISO', async () => {
    presets.current = testPreset({ limits: { dailyLossLimitBps: 400, maxDrawdownBps: 9000 } });
    const pool = createPool(db.url, { max: 3, options: `-c search_path=${db.schema} -c DateStyle=SQL,DMY` });
    try {
      const ro = officer('paper', {}, pool);
      await ro.fundPaperPool(10n * SOL);
      await ro.start('balanced');
      const d = await ro.reserve(request(fakeMint(), SOL, clock));
      if (!d.approved) throw new Error('vetoed');
      const mint = (await pool.query<{ mint: string }>('SELECT mint FROM reservations WHERE id = $1', [d.reservationId])).rows[0]!.mint;
      const { positionId } = await ro.recordFill({ reservationId: d.reservationId, orderId: 'b', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: SOL, tokenAmount: 1n, entryPriceUsd: 1, signature: null });
      await ro.markPositions([{ positionId, markLamports: SOL / 2n }]);
      expect(await stateOf(pool, 'paper')).toEqual({ state: 'halted', reason: 'daily_loss_limit' });
    } finally {
      await pool.end();
    }
  });
});

describe('fills with untrusted descriptive fields are always booked', () => {
  it('books a fill whose symbol has NUL bytes or is very long, and whose price is not finite', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    for (const [symbol, price] of [['EVIL\u0000COIN', 1], ['L'.repeat(500), Number.NaN], ['\u0007', -1]] as const) {
      const mint = fakeMint();
      const d = await ro.reserve(request(mint, SOL / 10n, clock));
      if (!d.approved) throw new Error('vetoed');
      const { positionId } = await ro.recordFill({ reservationId: d.reservationId, orderId: 'o', mint, symbol, strategy: 'momentum-v1', lamportsSpent: SOL / 10n, tokenAmount: 5n, entryPriceUsd: price, signature: null });
      const row = (await db.pool.query<{ symbol: string; entry_price_usd: number }>('SELECT symbol, entry_price_usd FROM positions WHERE id = $1', [positionId])).rows[0]!;
      expect(row.symbol).toBe(cleanSymbol(symbol));
      expect(Number.isFinite(row.entry_price_usd)).toBe(true);
    }
    expect(cleanSymbol('EVIL\u0000COIN')).toBe('EVILCOIN');
    expect([...cleanSymbol('L'.repeat(500))]).toHaveLength(64);
    expect(cleanSymbol('\u0007')).toBe('?');
    expect(await ledgerSum(db.pool, 'paper')).toBe(await cashOf(db.pool, 'paper'));
    expect((await audit.verify()).ok).toBe(true);
  });
});

describe('Token-2022 extensions are allowlisted, not just ban-listed', () => {
  const filters = testPreset().filters;

  it.each(['pausableConfig', 'confidentialMintBurn', 'scaledUiAmountConfig', 'unparseableExtension', 'someFutureExtension'])(
    'vetoes the unvetted extension %s',
    (ext) => {
      const c = candidate(fakeMint(), clock, { safety: { token2022Extensions: [ext] } });
      expect(tokenSafetyVeto(c, filters, clock.now())).toBe(`safety:unvetted_token2022_extension:${ext}`);
    },
  );

  it('accepts every vetted extension in any letter case', () => {
    const exts = ['metadataPointer', 'TOKENMETADATA', 'groupPointer', 'tokenGroup', 'groupMemberPointer', 'tokenGroupMember', 'MintCloseAuthority'];
    const c = candidate(fakeMint(), clock, { safety: { token2022Extensions: exts } });
    expect(tokenSafetyVeto(c, filters, clock.now())).toBeNull();
  });

  it('treats non-array extension data as invalid and keeps banned extensions on their own reason', () => {
    const bad = candidate(fakeMint(), clock, { safety: { token2022Extensions: 'metadataPointer' as unknown as string[] } });
    expect(tokenSafetyVeto(bad, filters, clock.now())).toBe('safety:token2022_unknown');
    const banned = candidate(fakeMint(), clock, { safety: { token2022Extensions: ['metadataPointer', 'TransferHook'] } });
    expect(tokenSafetyVeto(banned, filters, clock.now())).toBe('safety:token2022_extension:TransferHook');
  });

  it('reserve() refuses a mint with a pausable extension', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock, { safety: { token2022Extensions: ['pausableConfig'] } })))
      .toEqual({ approved: false, reason: 'safety:unvetted_token2022_extension:pausableConfig' });
  });
});
