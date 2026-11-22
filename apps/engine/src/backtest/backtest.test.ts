import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getPreset } from '@tidepool/core';
import { MINT_A, MINT_B } from '../trader/testkit.js';
import { main } from './cli.js';
import { generateSyntheticFixture } from './fixtures.js';
import { readJsonl, writeJsonl } from './io.js';
import { MemoryRiskOfficer } from './memoryRisk.js';
import { defaultScorer, runBacktest, SimClock, type Scorer } from './replay.js';
import { reportToJson, reportToMarkdown, SYNTHETIC_LABEL } from './report.js';
import { PricePointSchema, type BacktestInput, type PricePoint, type SignalEvent } from './types.js';
import { splitInput, walkForward } from './walkForward.js';

const small = () => generateSyntheticFixture({ seed: 7, mints: 4, days: 3, stepSeconds: 60 });

describe('backtest end to end on synthetic data', () => {
  it('produces a consistent, labeled report', async () => {
    const input = small();
    const r = await runBacktest(input, { preset: 'balanced', seed: 3 });
    expect(r.synthetic).toBe(true);
    expect(r.label).toBe(SYNTHETIC_LABEL);
    expect(r.summary.trades).toBeGreaterThan(0);
    // Totals agree with the trade list and with the equity change.
    expect(r.summary.totalTradeNetLamports).toBe(r.trades.reduce((a, t) => a + t.netLamports, 0n));
    expect(r.summary.netAfterAllCostsLamports).toBe(r.summary.totalTradeNetLamports - r.summary.failedBuyBurnLamports);
    expect(r.endingEquityLamports - r.startingEquityLamports).toBe(r.summary.netAfterAllCostsLamports);
    for (const t of r.trades) expect(t.netLamports).toBe(t.exitLamports - t.entryLamports - t.exitFailureBurnLamports);
    // Failed sells (seeded) burned fees that are attributed to their trades.
    const sellBurns = r.trades.reduce((a, t) => a + t.exitFailureBurnLamports, 0n);
    expect(sellBurns + r.summary.failedBuyBurnLamports).toBe(r.costs.failedTxBurnLamports);
    // Costs are non-negative and add up.
    const c = r.costs;
    for (const v of [
      c.venueFeeLamports,
      c.slippageLamports,
      c.priceImpactLamports,
      c.tipLamports,
      c.baseFeeLamports,
      c.failedTxBurnLamports,
    ])
      expect(v >= 0n).toBe(true);
    expect(c.totalLamports).toBe(
      c.venueFeeLamports +
        c.slippageLamports +
        c.priceImpactLamports +
        c.tipLamports +
        c.baseFeeLamports +
        c.failedTxBurnLamports,
    );
    expect(c.tipLamports).toBe(BigInt(c.filledTransactions) * getPreset('balanced').strategy.tipLamports);
    // Daily table covers the run and sums to the total.
    expect(r.daily.map((d) => d.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30']);
    expect(r.daily.reduce((a, d) => a + d.netLamports, 0n)).toBe(r.endingEquityLamports - r.startingEquityLamports);
    expect(r.daily.reduce((a, d) => a + d.trades, 0)).toBe(r.summary.trades);
    expect(r.vsSol).not.toBeNull();
    expect(r.summary.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(reportToMarkdown(r)).toContain('[SYNTHETIC]');
  });

  it('is reproducible for the same seed and differs for another seed', async () => {
    const input = small();
    const a = reportToJson(await runBacktest(input, { preset: 'balanced', seed: 3 }));
    const b = reportToJson(await runBacktest(input, { preset: 'balanced', seed: 3 }));
    expect(a).toBe(b);
    const c = reportToJson(await runBacktest(input, { preset: 'balanced', seed: 4, failureRate: 0.3 }));
    expect(c).not.toBe(a);
  });

  it('fixture generator is deterministic and marks data synthetic', () => {
    const a = generateSyntheticFixture({ seed: 1, mints: 2, days: 1, stepSeconds: 120 });
    const b = generateSyntheticFixture({ seed: 1, mints: 2, days: 1, stepSeconds: 120 });
    expect(a).toEqual(b);
    expect(a.signals.every((s) => s.source.startsWith('synthetic') && s.payload.synthetic === true)).toBe(true);
    expect(a.prices.every((p) => PricePointSchema.safeParse(p).success)).toBe(true);
  });
});

describe('loss limit', () => {
  // Hand-built data: day 1 a held token crashes 95%, which breaches the 4% daily loss limit;
  // a later signal that day must not enter, and entries resume on day 2.
  function crashInput(): BacktestInput {
    const prices: PricePoint[] = [];
    const signals: SignalEvent[] = [];
    const day1 = Date.parse('2026-11-01T00:00:00Z');
    const day2 = Date.parse('2026-11-02T00:00:00Z');
    for (const base of [day1, day2]) {
      for (let s = 0; s <= 3600; s += 30) {
        const t = base + s * 1000;
        const crashed = base === day1 && s >= 1200;
        prices.push({
          mint: MINT_A,
          at: new Date(t).toISOString(),
          priceLamportsPerUnit: crashed ? 0.05 : 1,
          liquidityUsd: crashed ? 300_000 : 1_000_000,
        });
        prices.push({ mint: MINT_B, at: new Date(t).toISOString(), priceLamportsPerUnit: 2, liquidityUsd: 1_000_000 });
      }
    }
    signals.push({
      source: 'test',
      mint: MINT_A,
      kind: 'mention',
      observedAt: new Date(day1 + 600_000).toISOString(),
      payload: {},
    });
    signals.push({
      source: 'test',
      mint: MINT_B,
      kind: 'mention',
      observedAt: new Date(day1 + 1_800_000).toISOString(),
      payload: {},
    });
    signals.push({
      source: 'test',
      mint: MINT_B,
      kind: 'mention',
      observedAt: new Date(day2 + 600_000).toISOString(),
      payload: {},
    });
    return { signals, prices };
  }
  const alwaysHot: Scorer = (ctx) => {
    const c = defaultScorer(ctx);
    return c && { ...c, score: 100 };
  };

  it('halts entries for the rest of the day and resumes the next day', async () => {
    const r = await runBacktest(crashInput(), { preset: 'balanced', scorer: alwaysHot, failureRate: 0 });
    expect(r.synthetic).toBe(false);
    expect(r.daily[0]).toMatchObject({ date: '2026-11-01', lossLimitHit: true, trades: 1 });
    expect(r.daily[1]).toMatchObject({ date: '2026-11-02', lossLimitHit: false });
    const first = r.trades[0]!;
    expect(first).toMatchObject({ mint: MINT_A, reason: 'stop_loss' });
    const bTrades = r.trades.filter((t) => t.mint === MINT_B);
    expect(bTrades.length).toBeGreaterThan(0);
    expect(bTrades.every((t) => t.openedAt.startsWith('2026-11-02'))).toBe(true);
    expect(r.summary.vetoes).toEqual({});
    expect(r.lossLimitDayShare).toBe(0.5);
  });

  it('the in-memory risk officer vetoes over-limit reservations', async () => {
    const clock = new SimClock(Date.parse('2026-11-01T00:00:00Z'));
    const risk = new MemoryRiskOfficer({ preset: getPreset('balanced'), startingLamports: 10_000_000_000n, clock });
    const cand = { mint: MINT_A, expiresAt: '2026-11-01T00:01:00Z' } as never;
    const big = await risk.reserve({
      idempotencyKey: 'k1',
      sleeve: 'momentum-v1',
      mint: MINT_A,
      lamports: 600_000_000n,
      candidate: cand,
      positionShareOfLiquidity: 0.001,
    });
    expect(big).toMatchObject({ approved: false, reason: expect.stringMatching(/position_cap/) });
    const thin = await risk.reserve({
      idempotencyKey: 'k2',
      sleeve: 'momentum-v1',
      mint: MINT_A,
      lamports: 100_000_000n,
      candidate: cand,
      positionShareOfLiquidity: 0.02,
    });
    expect(thin).toMatchObject({ approved: false, reason: expect.stringMatching(/liquidity/) });
    const ok = await risk.reserve({
      idempotencyKey: 'k3',
      sleeve: 'momentum-v1',
      mint: MINT_A,
      lamports: 500_000_000n,
      candidate: cand,
      positionShareOfLiquidity: 0.001,
    });
    expect(ok.approved).toBe(true);
    const again = await risk.reserve({
      idempotencyKey: 'k3',
      sleeve: 'momentum-v1',
      mint: MINT_A,
      lamports: 500_000_000n,
      candidate: cand,
      positionShareOfLiquidity: 0.001,
    });
    expect(again).toEqual(ok);
    expect(risk.equity()).toBe(10_000_000_000n);
  });
});

describe('walk-forward', () => {
  it('never gives tuning runs any data at or after the split', async () => {
    const input = small();
    const split = new Date('2026-10-30T00:00:00Z');
    let phase: 'tune' | 'test' | null = null;
    const seen = { tune: { maxNow: 0, maxSignal: 0, maxPrice: 0 }, test: { minNow: Number.POSITIVE_INFINITY } };
    const spy: Scorer = (ctx) => {
      const t = ctx.now.getTime();
      if (phase === 'tune') {
        seen.tune.maxNow = Math.max(seen.tune.maxNow, t);
        for (const s of ctx.signals) seen.tune.maxSignal = Math.max(seen.tune.maxSignal, Date.parse(s.observedAt));
        for (const p of ctx.prices) seen.tune.maxPrice = Math.max(seen.tune.maxPrice, Date.parse(p.at));
      } else if (phase === 'test') {
        seen.test.minNow = Math.min(seen.test.minNow, t);
      }
      return defaultScorer(ctx);
    };
    const grid = [{ takeProfitPct: 10 }, { takeProfitPct: 14 }, { takeProfitPct: 20, stopLossPct: 12 }];
    const r = await walkForward(input, {
      preset: 'balanced',
      seed: 3,
      split,
      grid,
      minTuneTrades: 1,
      scorer: spy,
      hooks: {
        onPhase: (p) => {
          phase = p;
        },
      },
    });
    expect(seen.tune.maxNow).toBeGreaterThan(0);
    expect(seen.tune.maxNow).toBeLessThan(split.getTime());
    expect(seen.tune.maxSignal).toBeLessThan(split.getTime());
    expect(seen.tune.maxPrice).toBeLessThan(split.getTime());
    expect(seen.test.minNow).toBeGreaterThanOrEqual(split.getTime());
    expect(Date.parse(r.tune.maxInputAt!)).toBeLessThan(split.getTime());
    expect(Date.parse(r.test.window.from)).toBeGreaterThanOrEqual(split.getTime());
    expect(r.tune.results).toHaveLength(3);
    expect(grid).toContainEqual(r.tune.chosen);
    expect(r.synthetic).toBe(true);
    expect(r.test.synthetic).toBe(true);
  });

  it('splitInput partitions every stream with no overlap', () => {
    const input = small();
    const split = new Date('2026-10-29T12:00:00Z');
    const { tune, test } = splitInput(input, split);
    expect(tune.signals.length + test.signals.length).toBe(input.signals.length);
    expect(tune.prices.length + test.prices.length).toBe(input.prices.length);
    expect(tune.solPrices!.every((p) => Date.parse(p.at) < split.getTime())).toBe(true);
    expect(test.prices.every((p) => Date.parse(p.at) >= split.getTime())).toBe(true);
  });
});

describe('io and cli', () => {
  it('round-trips JSONL and reports the offending line on bad input', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tidepool-bt-'));
    try {
      const f = generateSyntheticFixture({ seed: 2, mints: 1, days: 1, stepSeconds: 600 });
      await writeJsonl(join(dir, 'p.jsonl'), f.prices);
      expect(await readJsonl(join(dir, 'p.jsonl'), PricePointSchema)).toEqual(f.prices);
      await writeJsonl(join(dir, 'bad.jsonl'), [f.prices[0], { ...f.prices[0], priceLamportsPerUnit: -1 }]);
      await expect(readJsonl(join(dir, 'bad.jsonl'), PricePointSchema)).rejects.toThrow(/bad\.jsonl:2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('CLI writes labeled synthetic JSON and markdown reports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tidepool-cli-'));
    try {
      const f = generateSyntheticFixture({ seed: 5, mints: 2, days: 2, stepSeconds: 120 });
      await writeJsonl(join(dir, 's.jsonl'), f.signals);
      await writeJsonl(join(dir, 'p.jsonl'), f.prices);
      await writeJsonl(join(dir, 'sol.jsonl'), f.solPrices);
      const code = await main([
        '--signals',
        join(dir, 's.jsonl'),
        '--prices',
        join(dir, 'p.jsonl'),
        '--sol-prices',
        join(dir, 'sol.jsonl'),
        '--preset',
        'balanced',
        '--out',
        join(dir, 'out'),
      ]);
      expect(code).toBe(0);
      const files = (await readdir(join(dir, 'out'))).sort();
      expect(files).toHaveLength(2);
      expect(files.every((n) => n.startsWith('synthetic-backtest-balanced-'))).toBe(true);
      const md = await readFile(
        join(
          dir,
          'out',
          files.find((n) => n.endsWith('.md'))!,
        ),
        'utf8',
      );
      expect(md).toContain('SYNTHETIC DATA');
      const json = JSON.parse(
        await readFile(
          join(
            dir,
            'out',
            files.find((n) => n.endsWith('.json'))!,
          ),
          'utf8',
        ),
      );
      expect(json.synthetic).toBe(true);
      const wf = await main(['--synthetic-demo', '--walk-forward', '--split', '2026-10-30', '--out', join(dir, 'wf')]);
      expect(wf).toBe(0);
      expect((await readdir(join(dir, 'wf'))).every((n) => n.startsWith('synthetic-walkforward-'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('time-stop timing (review regression)', () => {
  it('fires at the deadline with the prices known then, not at the next recorded event', async () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const prices: PricePoint[] = [];
    for (let s = 0; s <= 600; s += 30)
      prices.push({
        mint: MINT_A,
        at: new Date(t0 + s * 1000).toISOString(),
        priceLamportsPerUnit: 1,
        liquidityUsd: 1_000_000,
      });
    // Data gap, then a price that would turn the late exit into a large take-profit.
    prices.push({
      mint: MINT_A,
      at: new Date(t0 + 2 * 3_600_000).toISOString(),
      priceLamportsPerUnit: 3,
      liquidityUsd: 1_000_000,
    });
    const signals: SignalEvent[] = [
      { source: 'test', mint: MINT_A, kind: 'mention', observedAt: new Date(t0 + 300_000).toISOString(), payload: {} },
    ];
    const hot: Scorer = (ctx) => {
      const c = defaultScorer(ctx);
      return c && { ...c, score: 100 };
    };
    const r = await runBacktest({ signals, prices }, { preset: 'balanced', scorer: hot, failureRate: 0 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.reason).toBe('time_stop');
    expect(t.holdSeconds).toBe(getPreset('balanced').strategy.timeStopSeconds);
    expect(t.netLamports < 0n).toBe(true); // flat price: the round trip costs money
  });
});
