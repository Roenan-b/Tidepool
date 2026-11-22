import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { LIVE_MODE_CONFIRMATION } from '@tidepool/core';
import { verifyTicket } from '@tidepool/core/ticket';
import { createTestSchema, type TestSchema } from '../db/testing.js';
import { PgAuditLog } from '../audit/pgAuditLog.js';
import { MemoryAlerter } from '../alerts/alerter.js';
import { PgRiskOfficer, type RiskOfficerSettings } from './pgRiskOfficer.js';
import { FakeClock, PresetBox, SOL, cashOf, fakeMint, ledgerSum, request, resetBook, stateOf, testPreset } from './testkit.js';

const SECRET = 'x'.repeat(48);
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

function officer(mode: 'paper' | 'live', config: Partial<RiskOfficerSettings> = {}): PgRiskOfficer {
  return new PgRiskOfficer({
    pool: db.pool, audit, clock, mode, preset: presets.resolver, alerter,
    ticketSecret: mode === 'live' ? SECRET : null,
    config: { liveTradingEnabled: true, signerConfigured: true, ...config },
  });
}

beforeEach(async () => {
  await resetBook(db.pool);
  clock = new FakeClock('2026-11-22T10:00:00.000Z');
  presets = new PresetBox(testPreset());
  audit = new PgAuditLog({ pool: db.pool, clock });
  alerter = new MemoryAlerter();
});

async function openPosition(ro: PgRiskOfficer, spent: bigint, reserve = spent, mint = fakeMint()) {
  const d = await ro.reserve(request(mint, reserve, clock));
  if (!d.approved) throw new Error(`reserve vetoed: ${d.reason}`);
  const { positionId } = await ro.recordFill({ reservationId: d.reservationId, orderId: 'buy', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: spent, tokenAmount: 1_000_000n, entryPriceUsd: 0.01, signature: null });
  return { positionId, reservationId: d.reservationId, mint };
}

async function expectInvariant(mode: 'paper' | 'live' = 'paper') {
  expect(await ledgerSum(db.pool, mode)).toBe(await cashOf(db.pool, mode));
}

describe('fill and exit accounting', () => {
  it('keeps cash and equity exact to the lamport', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const { positionId } = await openPosition(ro, 480_000_123n, 500_000_000n);
    expect(await cashOf(db.pool, 'paper')).toBe(10n * SOL - 480_000_123n);
    // Remainder released: no held reservations remain.
    const held = await db.pool.query(`SELECT 1 FROM reservations WHERE status = 'held'`);
    expect(held.rowCount).toBe(0);
    await expectInvariant();

    await ro.markPositions([{ positionId, markLamports: 600_000_000n }]);
    const pos = await ro.openPositions();
    expect(pos[0]!.markLamports).toBe(600_000_000n);

    await ro.authorizeExit(positionId, 'take_profit');
    const { realizedPnlLamports } = await ro.recordExit({ positionId, orderId: 'sell', lamportsReceived: 590_000_007n, reason: 'take_profit', signature: null });
    expect(realizedPnlLamports).toBe(590_000_007n - 480_000_123n);
    expect(await cashOf(db.pool, 'paper')).toBe(10n * SOL - 480_000_123n + 590_000_007n);
    await expectInvariant();
    // Repeated exit report is idempotent.
    expect((await ro.recordExit({ positionId, orderId: 'sell', lamportsReceived: 590_000_007n, reason: 'take_profit', signature: null })).realizedPnlLamports).toBe(realizedPnlLamports);
    expect(await cashOf(db.pool, 'paper')).toBe(10n * SOL - 480_000_123n + 590_000_007n);
  });

  it('books burned fees on release and on failed exits', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const d = await ro.reserve(request(fakeMint(), SOL / 2n, clock));
    if (!d.approved) throw new Error('vetoed');
    await ro.release(d.reservationId, 'transaction failed', 1_005_000n);
    await ro.release(d.reservationId, 'transaction failed', 1_005_000n); // idempotent
    expect(await cashOf(db.pool, 'paper')).toBe(10n * SOL - 1_005_000n);
    await expectInvariant();
    await expect(ro.release(d.reservationId, 'x', SOL)).rejects.toThrow(/exceeds/);

    const { positionId } = await openPosition(ro, SOL / 10n);
    await ro.recordExitFailure(positionId, 5_000n, 'slippage');
    expect(await cashOf(db.pool, 'paper')).toBe(10n * SOL - 1_005_000n - SOL / 10n - 5_000n);
    await expectInvariant();
    const r = await ro.reconcile();
    expect(r.status).toBe('ok');
  });

  it('records a fill against an expired reservation and warns', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const mint = fakeMint();
    const d = await ro.reserve(request(mint, SOL / 10n, clock));
    if (!d.approved) throw new Error('vetoed');
    clock.advance(120_000);
    await ro.expireStaleReservations();
    await ro.recordFill({ reservationId: d.reservationId, orderId: 'late', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: SOL / 10n, tokenAmount: 1n, entryPriceUsd: 1, signature: null });
    expect(alerter.alerts.some((a) => a.kind === 'accounting_warning')).toBe(true);
    await expectInvariant();
  });
});

describe('daily loss and drawdown limits', () => {
  it('daily loss limit halts entries, allows exits, and auto-clears next UTC day', async () => {
    presets.current = testPreset({ limits: { dailyLossLimitBps: 400, maxDrawdownBps: 9000 } }); // 0.4 SOL of 10
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const { positionId } = await openPosition(ro, SOL / 2n);
    await ro.markPositions([{ positionId, markLamports: SOL / 10n - 1n }]); // loss just over 0.4 SOL
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'halted', reason: 'daily_loss_limit' });
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock))).toEqual({ approved: false, reason: 'halted:daily_loss_limit' });
    expect((await ro.canOpenNewPositions()).ok).toBe(false);

    // Exits still work while halted.
    await ro.authorizeExit(positionId, 'stop_loss');
    await ro.recordExit({ positionId, orderId: 's', lamportsReceived: SOL / 10n, reason: 'stop_loss', signature: null });
    await expectInvariant();

    clock.set('2026-11-23T00:00:01.000Z');
    expect(await ro.canOpenNewPositions()).toEqual({ ok: true, reason: null });
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'running', reason: null });
    expect((await ro.reserve(request(fakeMint(), SOL / 10n, clock))).approved).toBe(true);
    expect(alerter.alerts.some((a) => a.kind === 'halt_cleared')).toBe(true);
  });

  it('a pause during a daily halt stays paused after the day rolls', async () => {
    presets.current = testPreset({ limits: { dailyLossLimitBps: 400 } });
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const { positionId } = await openPosition(ro, SOL / 2n);
    await ro.markPositions([{ positionId, markLamports: 0n }]);
    expect((await ro.pause()).ok).toBe(true);
    clock.set('2026-11-23T01:00:00.000Z');
    await ro.canOpenNewPositions();
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'paused', reason: null });
  });

  it('drawdown halts until an operator clears it', async () => {
    presets.current = testPreset({ limits: { maxDrawdownBps: 500, dailyLossLimitBps: 10_000 } }); // 5% of peak
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const { positionId } = await openPosition(ro, SOL);
    await ro.markPositions([{ positionId, markLamports: 2n * SOL }]); // equity 11 SOL, new peak
    await ro.markPositions([{ positionId, markLamports: 2n * SOL - 550_000_000n }]); // equity 10.45 = 5% below 11
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'halted', reason: 'drawdown_limit' });
    clock.set('2026-11-24T10:00:00.000Z');
    expect((await ro.canOpenNewPositions()).ok).toBe(false);
    expect((await ro.start('balanced')).ok).toBe(false);
    // Exits still work.
    await ro.authorizeExit(positionId, 'manual');
    await ro.recordExit({ positionId, orderId: 's', lamportsReceived: SOL, reason: 'manual', signature: null });
    const cleared = await ro.clearHalt('reviewed with owner', 'operator');
    expect(cleared).toMatchObject({ ok: true, state: 'paused' });
    expect((await ro.start('balanced')).ok).toBe(true);
    expect((await ro.reserve(request(fakeMint(), SOL / 10n, clock))).approved).toBe(true);
  });
});

describe('kill switch', () => {
  it('releases held reservations, marks positions closing, blocks entries but not exits', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const p1 = await openPosition(ro, SOL / 10n);
    const p2 = await openPosition(ro, SOL / 10n);
    const held = await ro.reserve(request(fakeMint(), SOL / 10n, clock));
    expect(held.approved).toBe(true);
    const k = await ro.killSwitch('owner');
    expect(k).toEqual({ positionsClosing: 2, reservationsReleased: 1 });
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'halted', reason: 'kill_switch' });
    const pos = await ro.openPositions();
    expect(pos.map((p) => p.status)).toEqual(['closing', 'closing']);
    expect(await ro.reserve(request(fakeMint(), SOL / 10n, clock))).toEqual({ approved: false, reason: 'halted:kill_switch' });
    for (const p of [p1, p2]) {
      await ro.authorizeExit(p.positionId, 'kill_switch');
      await ro.recordExit({ positionId: p.positionId, orderId: 'k', lamportsReceived: SOL / 10n, reason: 'kill_switch', signature: null });
    }
    expect(await ro.openPositions()).toHaveLength(0);
    expect(alerter.alerts.some((a) => a.kind === 'kill_switch')).toBe(true);
    expect((await ro.pause()).ok).toBe(false);
    await expectInvariant();
  });
});

describe('reconciliation', () => {
  it('paper mode halts when the ledger does not sum to cash', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    expect((await ro.reconcile()).status).toBe('ok');
    await db.pool.query(`INSERT INTO ledger_entries (mode, kind, lamports, note) VALUES ('paper', 'adjustment', 1, 'out-of-band write')`);
    const r = await ro.reconcile();
    expect(r.status).toBe('mismatch');
    expect(await stateOf(db.pool, 'paper')).toEqual({ state: 'halted', reason: 'reconciliation_mismatch' });
    const runs = await db.pool.query<{ ok: boolean }>('SELECT ok FROM reconciliation_runs ORDER BY id');
    expect(runs.rows.map((x) => x.ok)).toEqual([true, false]);
    expect(alerter.alerts.some((a) => a.kind === 'reconciliation_error')).toBe(true);
  });

  it('live mode compares wallet SOL with booked cash', async () => {
    const live = officer('live');
    expect(await live.bookDeposit(5n * SOL, '5'.repeat(88))).toEqual({ booked: true });
    expect(await live.bookDeposit(5n * SOL, '5'.repeat(88))).toEqual({ booked: false });
    expect((await live.reconcile(async () => 5n * SOL)).status).toBe('ok');
    const bad = await live.reconcile(async () => 5n * SOL - 1n);
    expect(bad.status).toBe('mismatch');
    expect(await stateOf(db.pool, 'live')).toEqual({ state: 'halted', reason: 'reconciliation_mismatch' });
  });

  it('live mode defers briefly while an in-flight buy can explain the gap, then halts', async () => {
    const paper = officer('paper');
    expect(await paper.setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: true, mode: 'live' });
    const live = officer('live', { reconcileMaxDeferrals: 1 });
    await live.bookDeposit(5n * SOL, '6'.repeat(88));
    await live.start('balanced');
    const d = await live.reserve(request(fakeMint(), SOL / 2n, clock));
    expect(d.approved).toBe(true);
    expect((await live.reconcile(async () => 5n * SOL - SOL / 2n)).status).toBe('deferred');
    expect((await live.reconcile(async () => 5n * SOL - SOL / 2n)).status).toBe('mismatch');
  });

  it('halts with rpc_errors after repeated fetch failures', async () => {
    const live = officer('live', { reconcileMaxFetchFailures: 2 });
    const fail = async (): Promise<bigint> => { throw new Error('timeout'); };
    expect((await live.reconcile(fail)).status).toBe('error');
    expect((await live.reconcile(fail)).status).toBe('error');
    expect(await stateOf(db.pool, 'live')).toEqual({ state: 'halted', reason: 'rpc_errors' });
  });
});

describe('live tickets and mode switching', () => {
  it('paper reservations carry no ticket', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const d = await ro.reserve(request(fakeMint(), SOL / 10n, clock));
    expect(d.approved && d.ticket).toBe(null);
  });

  it('live reservations carry a verifiable buy ticket; replay returns the same ticket', async () => {
    const live = officer('live');
    expect(() => new PgRiskOfficer({ pool: db.pool, audit, clock, mode: 'live', ticketSecret: 'short' })).toThrow();
    expect(await officer('paper').setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: true, mode: 'live' });
    await live.bookDeposit(10n * SOL, '7'.repeat(88));
    expect((await live.start('balanced')).ok).toBe(true);
    const mint = fakeMint();
    const req = request(mint, SOL / 10n, clock);
    const d = await live.reserve(req);
    if (!d.approved || !d.ticket) throw new Error('expected a ticket');
    expect(verifyTicket(d.ticket, SECRET, clock.now().getTime())).toEqual({ ok: true });
    expect(verifyTicket(d.ticket, 'y'.repeat(48), clock.now().getTime()).ok).toBe(false);
    expect(d.ticket.ticket).toMatchObject({
      intent: 'buy', mint, reservationId: d.reservationId,
      maxLamports: (SOL / 10n - presets.current.strategy.tipLamports).toString(),
      maxTipLamports: presets.current.strategy.tipLamports.toString(), destination: null,
      expiresAt: d.expiresAt.getTime(),
    });
    const replay = await live.reserve(req);
    expect(replay.approved && replay.ticket?.mac).toBe(d.ticket.mac);
    // Exits get a sell ticket.
    const { positionId } = await live.recordFill({ reservationId: d.reservationId, orderId: 'b', mint, symbol: 'T', strategy: 'momentum-v1', lamportsSpent: SOL / 10n, tokenAmount: 5n, entryPriceUsd: 1, signature: '3'.repeat(88) });
    const exit = await live.authorizeExit(positionId, 'take_profit');
    expect(exit.ticket?.ticket.intent).toBe('sell');
    expect(verifyTicket(exit.ticket!, SECRET, clock.now().getTime())).toEqual({ ok: true });
    // Cannot leave live while a position is open.
    expect(await live.setMode('paper', undefined)).toEqual({ ok: false, reason: 'open_positions_or_reservations' });
  });

  it('refuses live without the flag, the exact confirmation, or a signer', async () => {
    expect(await officer('paper', { liveTradingEnabled: false }).setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: false, reason: 'live_trading_disabled' });
    expect(await officer('paper').setMode('live', 'yes')).toEqual({ ok: false, reason: 'confirmation_required' });
    expect(await officer('paper').setMode('live', undefined)).toEqual({ ok: false, reason: 'confirmation_required' });
    expect(await officer('paper', { signerConfigured: false }).setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: false, reason: 'signer_not_configured' });
    // Refused while the current mode has open positions or held reservations.
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    await ro.reserve(request(fakeMint(), SOL / 10n, clock));
    expect(await ro.setMode('live', LIVE_MODE_CONFIRMATION)).toEqual({ ok: false, reason: 'open_positions_or_reservations' });
    // A non-active mode cannot be started.
    expect(await officer('live').start('balanced')).toEqual({ ok: false, reason: 'mode_not_active' });
  });

  it('fundPaperPool is refused in live mode', async () => {
    await expect(officer('live').fundPaperPool(SOL)).rejects.toThrow(/paper/);
  });
});

describe('withdrawals', () => {
  const addr = () => Keypair.generate().publicKey.toBase58();

  it('first paper address is immediate; later changes are timelocked 24h', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    const a1 = addr();
    const a2 = addr();
    expect((await ro.setWithdrawAddress(a1)).status).toBe('active');
    const pending = await ro.setWithdrawAddress(a2);
    expect(pending.status).toBe('pending');
    expect(pending.effectiveAt.getTime() - clock.now().getTime()).toBe(24 * 3600_000);
    expect(alerter.alerts.filter((a) => a.kind === 'withdraw_address_change')).toHaveLength(2);

    const w1 = await ro.requestWithdrawal(SOL);
    expect(w1).toMatchObject({ ok: true, destination: a1, ticket: null });
    expect(await ro.promotePendingWithdrawAddress()).toBe(false);
    clock.advance(24 * 3600_000);
    expect(await ro.promotePendingWithdrawAddress()).toBe(true);
    const w2 = await ro.requestWithdrawal(SOL);
    expect(w2).toMatchObject({ ok: true, destination: a2 });
    expect(await cashOf(db.pool, 'paper')).toBe(8n * SOL);
    await expectInvariant();
  });

  it('refuses without an address, beyond free cash, and rejects malformed addresses', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(SOL);
    expect(await ro.requestWithdrawal(SOL / 10n)).toEqual({ ok: false, reason: 'no_withdraw_address' });
    await expect(ro.setWithdrawAddress('not an address')).rejects.toThrow(/invalid address/);
    await ro.setWithdrawAddress(addr());
    // free = 1 SOL - 0.1 SOL fee reserve
    expect(await ro.requestWithdrawal(SOL - presets.current.limits.feeReserveLamports + 1n)).toEqual({ ok: false, reason: 'insufficient_free_cash' });
    expect((await ro.requestWithdrawal(SOL - presets.current.limits.feeReserveLamports)).ok).toBe(true);
    expect(await ro.requestWithdrawal(0n)).toEqual({ ok: false, reason: 'invalid_amount' });
  });

  it('live: first address is timelocked; withdrawal ticket is bound to the allowlisted address', async () => {
    expect(await officer('paper').setMode('live', LIVE_MODE_CONFIRMATION)).toMatchObject({ ok: true });
    const live = officer('live');
    await live.bookDeposit(3n * SOL, '8'.repeat(88));
    const a = addr();
    expect((await live.setWithdrawAddress(a)).status).toBe('pending');
    expect(await live.requestWithdrawal(SOL)).toEqual({ ok: false, reason: 'no_withdraw_address' });
    clock.advance(24 * 3600_000 + 1);
    const w = await live.requestWithdrawal(SOL);
    if (!w.ok || !w.ticket) throw new Error('expected a withdraw ticket');
    expect(w.ticket.ticket).toMatchObject({ intent: 'withdraw', destination: a, maxLamports: SOL.toString(), mint: null });
    expect(verifyTicket(w.ticket, SECRET, clock.now().getTime())).toEqual({ ok: true });
    // The hold blocks the funds until the transfer is booked.
    expect(await live.requestWithdrawal(2n * SOL)).toEqual({ ok: false, reason: 'insufficient_free_cash' });
    await live.recordWithdrawal(w.withdrawalId, SOL, 5_000n, '9'.repeat(88));
    expect(await cashOf(db.pool, 'live')).toBe(2n * SOL - 5_000n);
    await expectInvariant('live');
    expect((await live.reconcile(async () => 2n * SOL - 5_000n)).status).toBe('ok');
  });

  it('pending address change can be cancelled', async () => {
    const ro = officer('paper');
    await ro.setWithdrawAddress(addr());
    await ro.setWithdrawAddress(addr());
    expect(await ro.cancelPendingWithdrawAddress()).toBe(true);
    clock.advance(25 * 3600_000);
    expect(await ro.promotePendingWithdrawAddress()).toBe(false);
  });
});

describe('daily summary and audit', () => {
  it('sends a daily summary and keeps the audit chain intact', async () => {
    const ro = officer('paper');
    await ro.fundPaperPool(10n * SOL);
    await ro.start('balanced');
    const { positionId } = await openPosition(ro, SOL / 10n);
    await ro.recordExit({ positionId, orderId: 's', lamportsReceived: SOL / 5n, reason: 'take_profit', signature: null });
    const s = await ro.dailySummary();
    expect(s).toMatchObject({ trades: 1, wins: 1, realizedPnlLamports: SOL / 10n, netPnlLamports: SOL / 10n });
    expect(alerter.summaries).toHaveLength(1);
    expect((await audit.verify()).ok).toBe(true);
  });

  it('first start of an empty paper book funds it from the configured starting balance', async () => {
    const ro = officer('paper', { paperStartingLamports: 7n * SOL });
    await ro.start('balanced');
    expect(await cashOf(db.pool, 'paper')).toBe(7n * SOL);
    await ro.stop();
    await ro.start('balanced');
    expect(await cashOf(db.pool, 'paper')).toBe(7n * SOL);
    await expectInvariant();
  });
});
