/**
 * Walk-forward evaluation: split inputs by time into a tune window (before the split) and a test window
 * (at or after the split). A small grid of strategy parameters is evaluated on the tune window only; the
 * chosen parameters are then run once on the unseen test window, next to the preset defaults as a baseline.
 * The tune runs receive only records strictly before the split, so no test-window data can influence the choice.
 */
import { getPreset, type PresetName } from '@tidepool/core';
import type { MomentumParams } from '../trader/strategy.js';
import { runBacktest, type BacktestOptions } from './replay.js';
import type { BacktestReport } from './report.js';
import type { BacktestInput } from './types.js';

export type GridPoint = Partial<Pick<MomentumParams, 'takeProfitPct' | 'stopLossPct' | 'minScore' | 'timeStopSeconds'>>;

export interface WalkForwardOptions extends Omit<BacktestOptions, 'paramOverrides'> {
  split: Date;
  grid?: GridPoint[];
  /** A grid point needs at least this many tune-window trades to be eligible. */
  minTuneTrades?: number;
  hooks?: { onPhase?(phase: 'tune' | 'test'): void };
}

export interface WalkForwardResult {
  split: string;
  synthetic: boolean;
  tune: {
    window: { from: string | null; to: string | null };
    /** Latest timestamp of any record given to tuning runs (always before the split). */
    maxInputAt: string | null;
    results: { params: GridPoint; trades: number; netAfterAllCostsLamports: bigint; maxDrawdownPct: number }[];
    chosen: GridPoint;
    chosenFromGrid: boolean;
  };
  test: BacktestReport;
  baselineTest: BacktestReport;
}

export function defaultGrid(presetName: PresetName): GridPoint[] {
  const s = getPreset(presetName).strategy;
  const grid: GridPoint[] = [];
  for (const tp of [s.takeProfitPct * 0.7, s.takeProfitPct, s.takeProfitPct * 1.5]) {
    for (const sl of [s.stopLossPct * 0.75, s.stopLossPct, s.stopLossPct * 1.5]) {
      for (const ms of [s.minScore - 5, s.minScore, s.minScore + 5]) {
        grid.push({
          takeProfitPct: Math.round(tp * 10) / 10,
          stopLossPct: Math.round(sl * 10) / 10,
          minScore: Math.min(100, Math.max(0, ms)),
        });
      }
    }
  }
  return grid;
}

/** Splits every input stream at `split`: records strictly before go to tune, the rest to test. */
export function splitInput(input: BacktestInput, split: Date): { tune: BacktestInput; test: BacktestInput } {
  const t = split.getTime();
  const before = (iso: string) => Date.parse(iso) < t;
  const tune: BacktestInput = {
    signals: input.signals.filter((s) => before(s.observedAt)),
    prices: input.prices.filter((p) => before(p.at)),
  };
  const test: BacktestInput = {
    signals: input.signals.filter((s) => !before(s.observedAt)),
    prices: input.prices.filter((p) => !before(p.at)),
  };
  if (input.solPrices) {
    tune.solPrices = input.solPrices.filter((p) => before(p.at));
    test.solPrices = input.solPrices.filter((p) => !before(p.at));
  }
  return { tune, test };
}

function maxAt(input: BacktestInput): number | null {
  let m = Number.NEGATIVE_INFINITY;
  for (const s of input.signals) m = Math.max(m, Date.parse(s.observedAt));
  for (const p of input.prices) m = Math.max(m, Date.parse(p.at));
  for (const p of input.solPrices ?? []) m = Math.max(m, Date.parse(p.at));
  return Number.isFinite(m) ? m : null;
}

export async function walkForward(input: BacktestInput, opts: WalkForwardOptions): Promise<WalkForwardResult> {
  const { split, grid: gridOpt, minTuneTrades, hooks, ...base } = opts;
  if (!Number.isFinite(split.getTime())) throw new RangeError('invalid split date');
  const { tune, test } = splitInput(input, split);
  const tuneMax = maxAt(tune);
  if (tuneMax !== null && tuneMax >= split.getTime()) throw new Error('internal: tune window contains test data');
  const grid = gridOpt ?? defaultGrid(opts.preset);
  const minTrades = minTuneTrades ?? 3;
  const synthetic =
    opts.synthetic === true ||
    input.signals.some((s) => s.source.startsWith('synthetic') || s.payload.synthetic === true);

  hooks?.onPhase?.('tune');
  const results: WalkForwardResult['tune']['results'] = [];
  let tuneFrom: string | null = null;
  let tuneTo: string | null = null;
  for (const g of grid) {
    const r = await runBacktest(tune, { ...base, synthetic, paramOverrides: g });
    tuneFrom = r.window.from;
    tuneTo = r.window.to;
    results.push({
      params: g,
      trades: r.summary.trades,
      netAfterAllCostsLamports: r.summary.netAfterAllCostsLamports,
      maxDrawdownPct: r.summary.maxDrawdownPct,
    });
  }
  const eligible = results.filter((r) => r.trades >= minTrades);
  eligible.sort((a, b) =>
    b.netAfterAllCostsLamports > a.netAfterAllCostsLamports
      ? 1
      : b.netAfterAllCostsLamports < a.netAfterAllCostsLamports
        ? -1
        : a.maxDrawdownPct - b.maxDrawdownPct,
  );
  const best = eligible[0];
  const chosen: GridPoint = best ? best.params : {};

  hooks?.onPhase?.('test');
  const testReport = await runBacktest(test, { ...base, synthetic, paramOverrides: chosen });
  const baselineTest = await runBacktest(test, { ...base, synthetic, paramOverrides: {} });
  return {
    split: split.toISOString(),
    synthetic,
    tune: {
      window: { from: tuneFrom, to: tuneTo },
      maxInputAt: tuneMax === null ? null : new Date(tuneMax).toISOString(),
      results,
      chosen,
      chosenFromGrid: Boolean(best),
    },
    test: testReport,
    baselineTest,
  };
}
