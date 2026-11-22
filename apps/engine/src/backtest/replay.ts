/**
 * Replay harness. Feeds recorded signals and price series through the production Trader (strategy rules,
 * sizing, reservations, exits with retries), an in-memory Risk Officer that enforces the preset limits, and
 * the PaperBroker with the core cost model, under a simulated clock. Events are processed strictly in time
 * order and the scorer only ever sees history up to the current event, so there is no lookahead.
 */
import { COST_MODELS, getPreset, type Candidate, type CostModel, type Preset, type PresetName } from '@tidepool/core';
import type { CandidateSource, Clock } from '../contracts.js';
import { PaperBroker } from '../trader/paperBroker.js';
import { InMemoryOrderRepository } from '../trader/orders.js';
import { configVersion, momentumParams, type MomentumParams } from '../trader/strategy.js';
import { Trader, type SellRetryOptions } from '../trader/trader.js';
import type { QuoteResult, QuoteSource, Venue } from '../trader/types.js';
import { MemoryRiskOfficer } from './memoryRisk.js';
import { buildReport, type BacktestReport } from './report.js';
import { looksSynthetic, type BacktestInput, type PricePoint, type SignalEvent, type SolPricePoint } from './types.js';

export class SimClock implements Clock {
  private t: number;
  constructor(start: Date | number) { this.t = typeof start === 'number' ? start : start.getTime(); }
  now(): Date { return new Date(this.t); }
  set(ms: number): void {
    if (ms < this.t) throw new Error('simulated clock cannot go backwards');
    this.t = ms;
  }
}

interface MarketState { price: number; liquidityUsd: number; venue: Venue | undefined }

/**
 * Quotes from the replayed price series. Price impact follows a constant-product approximation:
 * impact ~= size / (liquidity / 2), applied against the trader (buy higher, sell lower).
 */
export class ReplayQuoteSource implements QuoteSource {
  private readonly state = new Map<string, MarketState>();
  constructor(private readonly solUsd: () => number) {}

  update(p: PricePoint): void {
    this.state.set(p.mint, { price: p.priceLamportsPerUnit, liquidityUsd: p.liquidityUsd, venue: p.venue });
  }

  lastPrice(mint: string): number | null { return this.state.get(mint)?.price ?? null; }

  async quote(mint: string, side: 'buy' | 'sell', amount: bigint): Promise<QuoteResult> {
    const s = this.state.get(mint);
    if (!s || amount <= 0n || s.liquidityUsd <= 0) return { priceLamportsPerUnit: 0, priceImpactPct: 0, routeOk: false };
    const liqLamports = (s.liquidityUsd / this.solUsd()) * 1e9;
    const sizeLamports = side === 'buy' ? Number(amount) : Number(amount) * s.price;
    const impact = Math.min(0.95, (2 * sizeLamports) / liqLamports);
    const px = side === 'buy' ? s.price * (1 + impact) : s.price * (1 - impact);
    const r: QuoteResult = { priceLamportsPerUnit: px, priceImpactPct: impact * 100, routeOk: true, midPriceLamportsPerUnit: s.price };
    if (s.venue) r.venue = s.venue;
    return r;
  }
}

export class ReplayCandidateSource implements CandidateSource {
  private readonly latest = new Map<string, Candidate>();
  set(c: Candidate): void { this.latest.set(c.mint, c); }
  async topCandidates(limit: number, now: Date): Promise<Candidate[]> {
    const t = now.getTime();
    return [...this.latest.values()]
      .filter((c) => Date.parse(c.expiresAt) > t)
      .sort((a, b) => b.score - a.score || (a.mint < b.mint ? -1 : 1))
      .slice(0, limit);
  }
}

export interface ScoreContext {
  mint: string;
  now: Date;
  /** Signals for this mint observed at or before now, oldest first, within the lookback window. */
  signals: readonly SignalEvent[];
  /** Price points for this mint at or before now, oldest first, within the lookback window. */
  prices: readonly PricePoint[];
  preset: Preset;
  solUsd: number;
}

/** Turns history into a candidate (or null). The lead can plug in the Scout's real scoring here. */
export type Scorer = (ctx: ScoreContext) => Candidate | null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Minimal default scorer: 5-minute price momentum plus mention velocity, with the preset's liquidity floor.
 * score = 50 + 1.5 * clamp(change5m%, -20, 20) + 4 * min(mentions per minute over 10 min, 5).
 * Safety facts are taken from the latest signal payload when present, otherwise assumed to pass
 * (the backtest measures strategy and costs, not the Scout's filters).
 */
export const defaultScorer: Scorer = (ctx) => {
  const { prices, signals, now } = ctx;
  if (prices.length < 2) return null;
  const last = prices[prices.length - 1]!;
  const t = now.getTime();
  if (last.liquidityUsd < ctx.preset.filters.minLiquidityUsd) return null;
  const ref = prices.find((p) => Date.parse(p.at) >= t - 5 * 60_000) ?? prices[0]!;
  const change5m = (last.priceLamportsPerUnit / ref.priceLamportsPerUnit - 1) * 100;
  const recent = signals.filter((s) => Date.parse(s.observedAt) >= t - 10 * 60_000);
  const velocity = recent.length / 10;
  const score = Math.max(0, Math.min(100, 50 + 1.5 * Math.max(-20, Math.min(20, change5m)) + 4 * Math.min(velocity, 5)));
  const latest = signals[signals.length - 1];
  const payload = latest?.payload ?? {};
  const symbol = typeof payload.symbol === 'string' ? payload.symbol.slice(0, 16) : ctx.mint.slice(0, 4);
  return {
    mint: ctx.mint,
    symbol,
    pairAddress: ctx.mint,
    score,
    features: {
      liquidityUsd: last.liquidityUsd, volume5mUsd: num(payload.volume5mUsd) ?? 0, volumeTrend: 1, priceChange5mPct: change5m,
      holderCount: num(payload.holderCount) ?? 0, holderGrowth15m: 1, mentionVelocity: velocity, sentiment: 0,
      narrativeLabel: null, narrativeScore: null, boosted: false,
    },
    safety: {
      mint: ctx.mint, mintAuthorityRevoked: true, freezeAuthorityRevoked: true, token2022Extensions: [],
      liquidityUsd: last.liquidityUsd, top10HolderShare: num(payload.top10HolderShare) ?? 0.2, creatorFlagged: false,
      ageSeconds: num(payload.ageSeconds) ?? 86_400, sellSimulationRatio: num(payload.sellSimulationRatio) ?? 0.97,
    },
    reasons: [`change5m ${change5m.toFixed(2)}%`, `mentions/min ${velocity.toFixed(2)}`],
    observedAt: latest ? new Date(Date.parse(latest.observedAt)).toISOString() : now.toISOString(),
    expiresAt: new Date(t + 60_000).toISOString(),
    priceUsd: (last.priceLamportsPerUnit * ctx.solUsd) / 1e9,
  };
};

export interface BacktestOptions {
  preset: PresetName;
  paramOverrides?: Partial<MomentumParams>;
  startingLamports?: bigint;
  /** Seed for paper transaction failures. */
  seed?: number;
  scorer?: Scorer;
  /** Overrides cost model failure rates when set. */
  failureRate?: number;
  costModels?: Record<Venue, CostModel>;
  /** SOL/USD used when no SOL series is supplied. */
  defaultSolUsd?: number;
  lookbackMs?: number;
  /** Mark the report as produced from synthetic data. Also set automatically when inputs look synthetic. */
  synthetic?: boolean;
  sell?: Partial<SellRetryOptions>;
  haltOnDrawdown?: boolean;
}

type Ev = { at: number; order: number; idx: number; kind: 'price' | 'signal' };

function solSeries(points: SolPricePoint[] | undefined) {
  const sorted = (points ?? []).map((p) => ({ at: Date.parse(p.at), solUsd: p.solUsd })).sort((a, b) => a.at - b.at);
  let i = -1;
  return {
    has: sorted.length > 0,
    /** Advance to time t (monotonic) and return the latest value at or before t. */
    at(t: number): number | null {
      while (i + 1 < sorted.length && sorted[i + 1]!.at <= t) i += 1;
      return i >= 0 ? sorted[i]!.solUsd : null;
    },
    firstUsed(from: number): number | null { return sorted.find((p) => p.at >= from)?.solUsd ?? sorted[0]?.solUsd ?? null; },
  };
}

/** Runs one replay and returns the report. Deterministic for the same inputs, options and seed. */
export async function runBacktest(input: BacktestInput, opts: BacktestOptions): Promise<BacktestReport> {
  const preset = getPreset(opts.preset);
  const params = momentumParams(preset, opts.paramOverrides);
  const startingLamports = opts.startingLamports ?? 10_000_000_000n;
  const lookback = opts.lookbackMs ?? 60 * 60_000;
  const defaultSol = opts.defaultSolUsd ?? 150;

  const events: Ev[] = [];
  input.prices.forEach((p, idx) => events.push({ at: Date.parse(p.at), order: 0, idx, kind: 'price' }));
  input.signals.forEach((s, idx) => { if (s.mint) events.push({ at: Date.parse(s.observedAt), order: 1, idx, kind: 'signal' }); });
  events.sort((a, b) => a.at - b.at || a.order - b.order || a.idx - b.idx);
  const firstAt = events[0]?.at ?? 0;
  const lastAt = events[events.length - 1]?.at ?? 0;

  const clock = new SimClock(firstAt);
  const sol = solSeries(input.solPrices);
  let solNow: number | null = sol.has ? null : defaultSol;
  const quotes = new ReplayQuoteSource(() => solNow ?? defaultSol);
  const broker = new PaperBroker({ quotes, costModels: opts.costModels ?? COST_MODELS, seed: opts.seed ?? 1, ...(opts.failureRate !== undefined ? { failureRate: opts.failureRate } : {}) });
  const risk = new MemoryRiskOfficer({ preset, startingLamports, clock, haltOnDrawdown: opts.haltOnDrawdown ?? true });
  const candidates = new ReplayCandidateSource();
  const orders = new InMemoryOrderRepository();
  let idSeq = 0;
  const trader = new Trader(
    {
      risk, broker, candidates, orders, clock,
      equityLamports: async () => risk.equity(),
      solUsd: () => solNow,
      costModelFor: (m) => broker.costModelFor(m),
      newId: () => `10000000-0000-4000-8000-${(++idSeq).toString(16).padStart(12, '0')}`,
      sleep: async () => undefined,
    },
    { manualTicks: true, paramOverrides: opts.paramOverrides ?? {}, sell: { stuckRetryMs: 30_000, ...opts.sell } },
  );
  await trader.start(opts.preset);

  const scorer = opts.scorer ?? defaultScorer;
  const hist = new Map<string, { signals: SignalEvent[]; prices: PricePoint[] }>();
  const histFor = (mint: string) => {
    let h = hist.get(mint);
    if (!h) { h = { signals: [], prices: [] }; hist.set(mint, h); }
    return h;
  };
  const trim = <T>(arr: T[], timeOf: (x: T) => number, t: number) => { while (arr.length > 0 && timeOf(arr[0]!) < t - lookback) arr.shift(); };

  const equity: Array<{ at: number; lamports: bigint }> = [{ at: firstAt, lamports: risk.equity() }];
  const entryStats = { ticks: 0, entered: 0, vetoed: 0, buyFailed: 0, skipped: 0 };

  const timeStopMs = params.timeStopSeconds * 1000;
  for (const ev of events) {
    // Time-stops that fall between events fire at their deadline with the prices known then. Without this the
    // exit would wait for the next recorded event and fill at a later price than the strategy specifies.
    for (;;) {
      const nowMs = clock.now().getTime();
      let due = Number.POSITIVE_INFINITY;
      for (const p of await risk.openPositions()) {
        const d = p.openedAt.getTime() + timeStopMs;
        if (d > nowMs && d < ev.at && d < due) due = d;
      }
      if (!Number.isFinite(due)) break;
      clock.set(due);
      if (sol.has) solNow = sol.at(due);
      risk.rollDay();
      await trader.runMonitorTick();
      await trader.drain();
      equity.push({ at: due, lamports: risk.equity() });
    }
    clock.set(ev.at);
    if (sol.has) solNow = sol.at(ev.at);
    risk.rollDay();
    let scored = false;
    if (ev.kind === 'price') {
      const p = input.prices[ev.idx]!;
      quotes.update(p);
      const h = histFor(p.mint);
      h.prices.push(p);
      trim(h.prices, (x) => Date.parse(x.at), ev.at);
    } else {
      const s = input.signals[ev.idx]!;
      const h = histFor(s.mint!);
      h.signals.push(s);
      trim(h.signals, (x) => Date.parse(x.observedAt), ev.at);
      const c = scorer({ mint: s.mint!, now: clock.now(), signals: h.signals, prices: h.prices, preset, solUsd: solNow ?? defaultSol });
      if (c && c.mint === s.mint) { candidates.set(c); scored = true; }
    }
    await trader.runMonitorTick();
    await trader.drain();
    if (scored) {
      const r = await trader.runEntryTick();
      if (r.status === 'ran') {
        entryStats.ticks += 1;
        for (const o of r.outcomes) {
          if (o.outcome.startsWith('entered')) entryStats.entered += 1;
          else if (o.outcome.startsWith('vetoed')) entryStats.vetoed += 1;
          else if (o.outcome.startsWith('released')) entryStats.buyFailed += 1;
          else entryStats.skipped += 1;
        }
      }
    }
    equity.push({ at: ev.at, lamports: risk.equity() });
  }

  // End of data: close everything at the last known prices; write off anything that still cannot be sold.
  for (let round = 0; round < 10; round++) {
    const n = await trader.closeAllPositions('manual', 'end of backtest data');
    await trader.drain();
    if (n === 0) break;
  }
  const unclosed = await risk.openPositions();
  for (const p of unclosed) risk.writeOff(p.id);
  equity.push({ at: lastAt, lamports: risk.equity() });
  await trader.stop();

  const synthetic = opts.synthetic === true || looksSynthetic(input);
  return buildReport({
    synthetic, preset: preset.name, params, configVersion: configVersion(preset.name, params), seed: opts.seed ?? 1,
    from: firstAt, to: lastAt, startingLamports, endingLamports: risk.equity(), trades: risk.trades, days: risk.days,
    equity, costs: broker.costs, failedBuyBurnLamports: risk.failedBuyBurnLamports, entryStats, writtenOff: unclosed.length,
    vetoes: Object.fromEntries(risk.vetoes), solUsdStart: sol.has ? sol.firstUsed(firstAt) : null, solUsdEnd: sol.has ? sol.at(lastAt) : null,
  });
}
