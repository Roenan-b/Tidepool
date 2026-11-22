import { describe, expect, it } from 'vitest';
import { COST_MODELS, type EngineState } from '@tidepool/core';
import type { ExitReport, ReservationRequest } from '../contracts.js';
import { InMemoryOrderRepository } from './orders.js';
import { entryIdempotencyKey } from './strategy.js';
import { FakeBroker, FakeRisk, makeCandidate, makeTicket, MINT_A, MINT_B, StaticCandidates } from './testkit.js';
import { Trader, type TraderOptions } from './trader.js';
import type { TraderAlert } from './types.js';

const T0 = new Date('2026-11-01T00:00:00Z');

function setup(o: { mode?: 'paper' | 'live'; options?: TraderOptions; gate?: Promise<void> } = {}) {
  const mode = o.mode ?? 'paper';
  let nowMs = T0.getTime();
  const clock = { now: () => new Date(nowMs) };
  const risk = new FakeRisk(mode, clock.now);
  const broker = new FakeBroker(mode);
  const cands = new StaticCandidates([makeCandidate({}, T0)], o.gate);
  const orders = new InMemoryOrderRepository();
  const alerts: TraderAlert[] = [];
  const states: EngineState[] = [];
  let ids = 0;
  const trader = new Trader(
    {
      risk,
      broker,
      candidates: cands,
      orders,
      clock,
      equityLamports: async () => 10_000_000_000n,
      solUsd: () => 150,
      costModelFor: () => COST_MODELS.graduated,
      alert: (a) => {
        alerts.push(a);
      },
      onStateChange: (s) => {
        states.push(s);
      },
      sleep: async () => undefined,
      newId: () => `00000000-0000-4000-8000-${(++ids).toString().padStart(12, '0')}`,
    },
    { manualTicks: true, ...o.options },
  );
  return {
    trader,
    risk,
    broker,
    cands,
    orders,
    alerts,
    states,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function openPosition(risk: FakeRisk, mint = MINT_A, id = 'pos-x') {
  risk.positions.push({
    id,
    mint,
    symbol: 'TEST',
    strategy: 'momentum-v1',
    status: 'open',
    entryLamports: 1_000_000_000n,
    tokenAmount: 1_000_000_000n,
    entryPriceUsd: 0.15,
    openedAt: T0,
    markLamports: null,
  });
}

describe('Trader entries', () => {
  it('rejects a broker/risk mode mismatch', () => {
    const risk = new FakeRisk('paper');
    expect(
      () =>
        new Trader({
          risk,
          broker: new FakeBroker('live'),
          candidates: new StaticCandidates(),
          orders: new InMemoryOrderRepository(),
          equityLamports: async () => 1n,
          solUsd: () => 1,
          costModelFor: () => COST_MODELS.graduated,
        }),
    ).toThrow(/mode mismatch/);
  });

  it('does nothing before start', async () => {
    const s = setup();
    expect(await s.trader.runEntryTick()).toEqual({ status: 'disabled' });
    expect(s.cands.calls).toBe(0);
  });

  it('buys only inside an approved reservation and records the fill', async () => {
    const s = setup();
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({ status: 'ran', entered: 1 });
    expect(s.risk.count('reserve')).toBe(1);
    const req = s.risk.argsOf<ReservationRequest>('reserve')[0]!;
    expect(req.lamports).toBe(500_000_000n); // 5% of 10 SOL, liquidity is deep
    expect(req.sleeve).toBe('momentum-v1');
    expect(s.broker.buys).toHaveLength(1);
    expect(s.broker.buys[0]!.lamportsIn).toBe(500_000_000n - 505_000n); // minus tip and base fee
    expect(s.broker.buys[0]!.slippageBps).toBe(150);
    const fill = s.risk.argsOf<{ lamportsSpent: bigint; reservationId: string }>('recordFill')[0]!;
    expect(fill).toMatchObject({ reservationId: 'res-1', lamportsSpent: 500_000_000n });
    const [order] = s.orders.list();
    expect(order).toMatchObject({
      side: 'buy',
      status: 'landed',
      reservationId: 'res-1',
      lamports: 500_000_000n,
      positionId: 'pos-2',
    });
    expect(order!.signalAt?.toISOString()).toBe(T0.toISOString());
    expect(order!.submittedAt).not.toBeNull();
    expect(order!.landedAt).not.toBeNull();
    expect(order!.configVersion).toMatch(/^momentum-v1@/);
  });

  it('a veto means no broker buy', async () => {
    const s = setup();
    s.risk.approve = false;
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({ status: 'ran', entered: 0 });
    expect(s.risk.count('reserve')).toBe(1);
    expect(s.broker.buys).toHaveLength(0);
    expect(s.orders.list()).toHaveLength(0);
  });

  it('a halted risk officer means no reservation request at all', async () => {
    const s = setup();
    s.risk.canOpen = false;
    await s.trader.start('balanced');
    expect(await s.trader.runEntryTick()).toMatchObject({ status: 'blocked' });
    expect(s.risk.count('reserve')).toBe(0);
    expect(s.broker.buys).toHaveLength(0);
  });

  it('a failed buy releases the reservation with the burned fee', async () => {
    const s = setup();
    s.broker.buyResult = { ok: false, error: 'blockhash expired', burnedFeeLamports: 505_000n };
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    expect(s.risk.argsOf('release')).toEqual([
      { reservationId: 'res-1', reason: 'buy failed: blockhash expired', burned: 505_000n },
    ]);
    expect(s.risk.count('recordFill')).toBe(0);
    expect(s.orders.list()[0]).toMatchObject({ status: 'failed', feeLamports: 505_000n, error: 'blockhash expired' });
  });

  it('paper broker exception releases; live broker exception leaves the reservation held and alerts', async () => {
    const p = setup();
    p.broker.buyResult = new Error('socket hang up');
    await p.trader.start('balanced');
    await p.trader.runEntryTick();
    expect(p.risk.count('release')).toBe(1);

    const l = setup({ mode: 'live' });
    l.risk.ticketFor = (req) => makeTicket('buy', req.mint, req.lamports, T0.getTime() + 30_000);
    l.broker.buyResult = new Error('socket hang up');
    await l.trader.start('balanced');
    await l.trader.runEntryTick();
    expect(l.risk.count('release')).toBe(0);
    expect(l.alerts.map((a) => a.code)).toContain('buy_outcome_unknown');
  });

  it('live mode refuses to buy without a matching ticket', async () => {
    const s = setup({ mode: 'live' });
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    expect(s.broker.buys).toHaveLength(0);
    expect(s.risk.argsOf<{ reason: string }>('release')[0]!.reason).toBe('live mode without ticket');

    const w = setup({ mode: 'live' });
    w.risk.ticketFor = (req) => makeTicket('buy', MINT_B, req.lamports, T0.getTime() + 30_000);
    await w.trader.start('balanced');
    await w.trader.runEntryTick();
    expect(w.broker.buys).toHaveLength(0);
    expect(w.risk.argsOf<{ reason: string }>('release')[0]!.reason).toBe('ticket mint mismatch');

    const ok = setup({ mode: 'live' });
    ok.risk.ticketFor = (req) => makeTicket('buy', req.mint, req.lamports, T0.getTime() + 30_000);
    await ok.trader.start('balanced');
    await ok.trader.runEntryTick();
    expect(ok.broker.buys).toHaveLength(1);
    expect(ok.broker.buys[0]!.ticket?.ticket.intent).toBe('buy');
  });

  it('uses a stable idempotency key and never retries the same observation', async () => {
    const s = setup();
    s.risk.approve = false;
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    await s.trader.runEntryTick();
    const keys = s.risk.argsOf<ReservationRequest>('reserve').map((r) => r.idempotencyKey);
    expect(keys).toEqual([entryIdempotencyKey('momentum-v1', MINT_A, T0.toISOString())]);
    s.cands.list = [makeCandidate({ observedAt: new Date(T0.getTime() + 1000).toISOString() }, T0)];
    await s.trader.runEntryTick();
    const keys2 = s.risk.argsOf<ReservationRequest>('reserve').map((r) => r.idempotencyKey);
    expect(keys2).toHaveLength(2);
    expect(keys2[1]).not.toBe(keys2[0]);
  });

  it('never re-enters a mint already held', async () => {
    const s = setup();
    openPosition(s.risk, MINT_A);
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({
      status: 'ran',
      entered: 0,
      outcomes: [{ mint: MINT_A, outcome: 'skip: already held or in flight' }],
    });
    expect(s.broker.quotes.filter((q) => q.side === 'buy')).toHaveLength(0);
    expect(s.risk.count('reserve')).toBe(0);
  });

  it('does not enter the same mint twice in one tick or after a fill', async () => {
    const s = setup();
    s.cands.list = [makeCandidate({}, T0), makeCandidate({ observedAt: new Date(T0.getTime() + 1).toISOString() }, T0)];
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    expect(s.broker.buys).toHaveLength(1);
    s.cands.list = [makeCandidate({ observedAt: new Date(T0.getTime() + 2).toISOString() }, T0)];
    await s.trader.runEntryTick();
    expect(s.broker.buys).toHaveLength(1);
  });

  it('skips entries when price impact is at or above the cap', async () => {
    const s = setup();
    s.broker.impactPct = 2;
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({ entered: 0 });
    expect(s.risk.count('reserve')).toBe(0);
  });

  it('never overlaps entry ticks', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const s = setup({ gate });
    await s.trader.start('balanced');
    const first = s.trader.runEntryTick();
    await new Promise((r) => setImmediate(r));
    expect(await s.trader.runEntryTick()).toEqual({ status: 'skipped_overlap' });
    open();
    expect(await first).toMatchObject({ status: 'ran' });
    expect(s.cands.calls).toBe(1);
  });
});

describe('Trader exits', () => {
  it('takes profit on marked value net of costs, and marks positions first', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 1.2);
    s.broker.defaultSell = { ok: true, lamportsReceived: 1_180_000_000n, signature: null };
    await s.trader.start('balanced');
    expect(await s.trader.runMonitorTick()).toMatchObject({ status: 'ran', marked: 1, exitsStarted: 1 });
    await s.trader.drain();
    expect(s.risk.count('markPositions')).toBe(1);
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({
      positionId: 'pos-x',
      reason: 'take_profit',
      lamportsReceived: 1_180_000_000n,
    });
    const sellOrder = s.orders.list().find((o) => o.side === 'sell');
    expect(sellOrder).toMatchObject({ status: 'landed', positionId: 'pos-x', tokenAmount: 1_000_000_000n });
  });

  it('holds when gross is above take-profit but net after costs is not', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 1.15);
    await s.trader.start('balanced');
    expect(await s.trader.runMonitorTick()).toMatchObject({ exitsStarted: 0 });
  });

  it('retries a failed sell with escalating, capped slippage and books each burned fee via recordExitFailure', async () => {
    const s = setup({ options: { sell: { maxAttempts: 4, slippageStepBps: 100, maxSlippageBps: 300 } } });
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 0.5);
    const fail = { ok: false as const, error: 'slippage exceeded', burnedFeeLamports: 505_000n };
    s.broker.sellResults = [fail, fail, fail, { ok: true, lamportsReceived: 480_000_000n, signature: null }];
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells.map((x) => x.slippageBps)).toEqual([150, 250, 300, 300]);
    expect(s.risk.count('authorizeExit')).toBe(4);
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({
      reason: 'stop_loss',
      lamportsReceived: 480_000_000n,
    });
    expect(s.risk.argsOf('recordExitFailure')).toEqual(
      [1, 2, 3].map(() => ({ positionId: 'pos-x', burnedFeeLamports: 505_000n, error: 'slippage exceeded' })),
    );
    expect(
      s.orders
        .list()
        .filter((o) => o.side === 'sell')
        .map((o) => o.status),
    ).toEqual(['failed', 'failed', 'failed', 'landed']);
  });

  it('alerts when a position cannot be exited and backs off until the kill switch', async () => {
    const s = setup({ options: { sell: { maxAttempts: 2, stuckRetryMs: 60_000 } } });
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 0.5);
    const fail = { ok: false as const, error: 'no route', burnedFeeLamports: 0n };
    s.broker.sellResults = [fail, fail];
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.alerts.map((a) => a.code)).toContain('exit_failed');
    expect(s.risk.count('recordExit')).toBe(0);
    // Within the back-off window the monitor does not hammer the venue.
    expect(await s.trader.runMonitorTick()).toMatchObject({ exitsStarted: 0 });
    // The kill switch ignores the back-off.
    expect(await s.trader.killSwitch()).toEqual({ positionsClosing: 1 });
    await s.trader.drain();
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({ reason: 'kill_switch' });
  });

  it('kill switch sells every open position while halted and without a start', async () => {
    const s = setup();
    openPosition(s.risk, MINT_A, 'p1');
    openPosition(s.risk, MINT_B, 'p2');
    s.risk.canOpen = false;
    expect(await s.trader.killSwitch()).toEqual({ positionsClosing: 2 });
    await s.trader.drain();
    expect(s.broker.sells.map((x) => x.mint).sort()).toEqual([MINT_A, MINT_B].sort());
    expect(s.risk.argsOf<ExitReport>('recordExit').map((e) => e.reason)).toEqual(['kill_switch', 'kill_switch']);
    expect(s.risk.argsOf<{ reason: string }>('halt')[0]!.reason).toBe('kill_switch');
    expect(s.states).toContain('halted');
    expect(s.alerts.map((a) => a.code)).toContain('kill_switch');
    // Entries stay off after the kill switch.
    expect(await s.trader.runEntryTick()).toEqual({ status: 'disabled' });
  });

  it('sells a position the risk officer marked closing, regardless of exit rules', async () => {
    const s = setup();
    openPosition(s.risk);
    s.risk.positions[0] = { ...s.risk.positions[0]!, status: 'closing' };
    s.risk.canOpen = false;
    s.broker.price.set(MINT_A, 1.0); // flat: no strategy exit would fire
    await s.trader.start('balanced');
    expect(await s.trader.runMonitorTick()).toMatchObject({ exitsStarted: 1 });
    await s.trader.drain();
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({ positionId: 'pos-x', reason: 'manual' });
  });

  it('live sells refuse a ticket whose tip allowance is below the strategy tip', async () => {
    const s = setup({ mode: 'live', options: { sell: { maxAttempts: 1 } } });
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 2);
    s.risk.exitTicket = () => ({
      ...makeTicket('sell', MINT_A, 10_000_000n, T0.getTime() + 30_000),
      ticket: { ...makeTicket('sell', MINT_A, 10_000_000n, T0.getTime() + 30_000).ticket, maxTipLamports: '1' },
    });
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(0);
    s.risk.exitTicket = () => makeTicket('sell', MINT_A, 10_000_000n, T0.getTime() + 120_000);
    s.advance(61_000);
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(1);
    expect(s.broker.sells[0]!.ticket?.ticket.intent).toBe('sell');
  });

  it('pause stops entries but exits still run', async () => {
    const s = setup();
    await s.trader.start('balanced');
    await s.trader.pause();
    expect(s.states).toEqual(['running', 'paused']);
    expect(await s.trader.runEntryTick()).toEqual({ status: 'disabled' });
    expect(s.cands.calls).toBe(0);
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 2);
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.risk.count('recordExit')).toBe(1);
  });

  it('time-stops a flat position', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 1.0);
    await s.trader.start('balanced');
    expect(await s.trader.runMonitorTick()).toMatchObject({ exitsStarted: 0 });
    s.advance(20 * 60_000);
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({ reason: 'time_stop' });
  });

  it('alerts after repeated failed marks', async () => {
    const s = setup({ options: { unquotableAlertAfter: 2 } });
    openPosition(s.risk);
    s.broker.routeOk = false;
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.runMonitorTick();
    expect(s.alerts.map((a) => a.code)).toContain('position_unquotable');
    expect(s.risk.count('markPositions')).toBe(0);
  });

  it('a stop-loss exit puts the mint on cooldown', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 0.5);
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    s.cands.list = [makeCandidate({ observedAt: new Date(T0.getTime() + 5).toISOString() }, T0)];
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({ outcomes: [{ mint: MINT_A, outcome: 'skip: cooldown after stop-loss' }] });
  });

  it('real timers: loops run on their own and stop cleanly', async () => {
    const s = setup({ options: { manualTicks: false, entryTickMs: 5, monitorTickMs: 5 } });
    await s.trader.start('balanced');
    await new Promise((r) => setTimeout(r, 40));
    await s.trader.stop();
    expect(s.cands.calls).toBeGreaterThan(0);
    const after = s.cands.calls;
    await new Promise((r) => setTimeout(r, 20));
    expect(s.cands.calls).toBe(after);
    expect(s.states.at(-1)).toBe('stopped');
  });
});

describe('Trader review regressions', () => {
  const liveTickets = (s: ReturnType<typeof setup>) => {
    s.risk.ticketFor = (req) => makeTicket('buy', req.mint, req.lamports, T0.getTime() + 30_000);
    s.risk.exitTicket = () => makeTicket('sell', MINT_A, 10_000_000n, T0.getTime() + 10 * 60_000);
  };

  it('a kill switch that lands while the reservation is being approved stops the buy', async () => {
    const s = setup();
    s.risk.onReserve = async () => {
      s.risk.onReserve = null;
      await s.trader.killSwitch();
    };
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({
      status: 'ran',
      entered: 0,
      outcomes: [{ mint: MINT_A, outcome: 'released: entries disabled before submit' }],
    });
    expect(s.broker.buys).toHaveLength(0);
    expect(s.risk.argsOf<{ reason: string }>('release')).toEqual([
      { reservationId: 'res-1', reason: 'entries disabled before submit', burned: 0n },
    ]);
  });

  it('subtracts the broker-reported extra buy overhead so the spend stays inside the reservation', async () => {
    const s = setup();
    const extra = 2_110_000n;
    Object.assign(s.broker, { extraBuyOverheadLamports: () => extra });
    s.broker.buyResult = (a) => ({
      ok: true,
      lamportsSpent: a.lamportsIn + a.tipLamports + 5_000n + extra,
      tokenAmount: 1_000n,
      signature: null,
    });
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    const req = s.risk.argsOf<ReservationRequest>('reserve')[0]!;
    expect(s.broker.buys[0]!.lamportsIn).toBe(req.lamports - 505_000n - extra);
    expect(s.risk.argsOf<{ lamportsSpent: bigint }>('recordFill')[0]!.lamportsSpent).toBe(req.lamports);
    expect(s.alerts).toEqual([]);
  });

  it('alerts when a buy spent more than was reserved (e.g. token account rent not budgeted)', async () => {
    const s = setup();
    s.broker.buyResult = (a) => ({
      ok: true,
      lamportsSpent: a.lamportsIn + a.tipLamports + 5_000n + 2_039_280n,
      tokenAmount: 1_000n,
      signature: null,
    });
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    expect(s.alerts.map((a) => a.code)).toContain('spend_above_reservation');
    expect(s.risk.count('recordFill')).toBe(1); // the spend happened, so it is still booked
  });

  it('a buy that lands without tokens is booked as a loss, not as an unsellable position', async () => {
    const s = setup();
    s.broker.buyResult = { ok: true, lamportsSpent: 0n, tokenAmount: 0n, signature: null };
    await s.trader.start('balanced');
    const r = await s.trader.runEntryTick();
    expect(r).toMatchObject({ outcomes: [{ outcome: 'released: buy landed without tokens' }] });
    expect(s.risk.count('recordFill')).toBe(0);
    expect(s.risk.argsOf('release')).toEqual([
      { reservationId: 'res-1', reason: 'buy landed without tokens', burned: 500_000_000n },
    ]);
    expect(s.alerts.map((a) => a.code)).toContain('buy_no_tokens');
  });

  it('a landed buy whose recordFill fails is retried by the monitor and the mint is never bought twice', async () => {
    const s = setup();
    s.risk.failRecordFill = 1;
    await s.trader.start('balanced');
    expect(await s.trader.runEntryTick()).toMatchObject({
      outcomes: [{ outcome: 'entered: recordFill failed; will retry' }],
    });
    s.cands.list = [makeCandidate({ observedAt: new Date(T0.getTime() + 1_000).toISOString() }, T0)];
    expect(await s.trader.runEntryTick()).toMatchObject({ outcomes: [{ outcome: 'skip: already held or in flight' }] });
    await s.trader.runMonitorTick();
    expect(s.risk.argsOf<{ reservationId: string }>('recordFill').map((f) => f.reservationId)).toEqual([
      'res-1',
      'res-1',
    ]);
    expect(s.risk.positions).toHaveLength(1);
    expect(s.orders.list()[0]!.positionId).toBe(s.risk.positions[0]!.id);
    expect(s.broker.buys).toHaveLength(1);
  });

  it('after a live buy with an unknown outcome the mint is blocked for new observations until the window passes', async () => {
    const s = setup({ mode: 'live', options: { unresolvedEntryBlockMs: 5_000 } });
    liveTickets(s);
    s.broker.buyResult = new Error('confirmation timeout');
    await s.trader.start('balanced');
    await s.trader.runEntryTick();
    s.cands.list = [makeCandidate({ observedAt: new Date(T0.getTime() + 1_000).toISOString() }, T0)];
    expect(await s.trader.runEntryTick()).toMatchObject({ outcomes: [{ outcome: 'skip: already held or in flight' }] });
    expect(s.broker.buys).toHaveLength(1);
    s.advance(6_000);
    const later = new Date(T0.getTime() + 6_000);
    s.cands.list = [makeCandidate({}, later)];
    s.risk.ticketFor = (req) => makeTicket('buy', req.mint, req.lamports, later.getTime() + 30_000);
    s.broker.buyResult = { ok: true, lamportsSpent: 0n, tokenAmount: 1_000n, signature: 'sig' };
    await s.trader.runEntryTick();
    expect(s.broker.buys).toHaveLength(2);
  });

  it('a landed sell whose booking fails is booked on the next pass and never sold again', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 2);
    s.risk.failRecordExit = 1;
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(1);
    expect(s.risk.positions).toHaveLength(1);
    expect(s.alerts.map((a) => a.code)).toContain('record_failed');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(1);
    expect(s.risk.argsOf<ExitReport>('recordExit').map((e) => e.orderId)).toHaveLength(2);
    const [a, b] = s.risk.argsOf<ExitReport>('recordExit');
    expect(b).toEqual(a);
    expect(s.risk.positions).toHaveLength(0);
  });

  it('sell proceeds below the transaction fees are booked as a burn plus a zero exit', async () => {
    const s = setup();
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 0.5);
    s.broker.defaultSell = { ok: true, lamportsReceived: -3_000n, signature: null };
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.risk.argsOf('recordExitFailure')).toEqual([
      { positionId: 'pos-x', burnedFeeLamports: 3_000n, error: 'sell proceeds below transaction fees' },
    ]);
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({ lamportsReceived: 0n, reason: 'stop_loss' });
  });

  it('a live sell with an unknown outcome is not resold right away, not even by the kill switch', async () => {
    const s = setup({ mode: 'live', options: { sell: { stuckRetryMs: 60_000 } } });
    liveTickets(s);
    openPosition(s.risk);
    s.broker.price.set(MINT_A, 0.5);
    s.broker.sellResults = [new Error('confirmation timeout')];
    await s.trader.start('balanced');
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(1);
    expect(s.alerts.map((a) => a.code)).toContain('sell_outcome_unknown');
    expect(s.risk.count('recordExitFailure')).toBe(0);
    await s.trader.runMonitorTick();
    await s.trader.killSwitch();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(1);
    s.advance(61_000);
    await s.trader.runMonitorTick();
    await s.trader.drain();
    expect(s.broker.sells).toHaveLength(2);
    expect(s.risk.argsOf<ExitReport>('recordExit')[0]).toMatchObject({ reason: 'kill_switch' });
  });
});
