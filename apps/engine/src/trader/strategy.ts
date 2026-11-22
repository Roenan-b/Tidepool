/**
 * momentum-v1: deterministic entry and exit rules.
 *
 * Every function here is pure: same inputs, same output, no clock or network access. The Trader and the
 * backtest call the same functions, so a backtest result describes the code that trades.
 * Every decision carries a reason string that goes into logs, the audit trail and order records.
 */
import { createHash } from 'node:crypto';
import { bpsOf, minBig, simulateSell, type Candidate, type CostModel, type Preset, type StrategyParams } from '@tidepool/core';

export const STRATEGY_NAME = 'momentum-v1';
/** Bump on any change to the rules in this file. Stamped on every order and position via configVersion(). */
export const STRATEGY_VERSION = 'momentum-v1@1.0.0';

export interface MomentumParams extends StrategyParams {
  /** Max quoted price impact accepted at entry, in percent. Estimate; tune with paper data. */
  maxPriceImpactPct: number;
  /** Positions smaller than this are not worth the fixed per-transaction costs. */
  minPositionLamports: bigint;
  /** Hard cap from the preset limits, bps of pool equity. */
  maxPositionBps: number;
  /** Hard cap from the preset filters, share (0..1) of the token's liquidity. */
  maxPositionShareOfLiquidity: number;
  /** Absolute cap in lamports (live mode: kept under the signer's per-transaction limit). */
  maxPositionLamports?: bigint;
}

export const DEFAULT_MAX_PRICE_IMPACT_PCT = 2;
export const DEFAULT_MIN_POSITION_LAMPORTS = 20_000_000n; // 0.02 SOL

export function momentumParams(preset: Preset, overrides: Partial<MomentumParams> = {}): MomentumParams {
  const p: MomentumParams = {
    ...preset.strategy,
    maxPriceImpactPct: DEFAULT_MAX_PRICE_IMPACT_PCT,
    minPositionLamports: DEFAULT_MIN_POSITION_LAMPORTS,
    maxPositionBps: preset.limits.maxPositionBps,
    maxPositionShareOfLiquidity: preset.filters.maxPositionShareOfLiquidity,
    ...overrides,
  };
  validateParams(p);
  return p;
}

export function validateParams(p: MomentumParams): void {
  const finitePos = (n: number) => Number.isFinite(n) && n > 0;
  if (!finitePos(p.takeProfitPct)) throw new RangeError('takeProfitPct must be positive');
  if (!finitePos(p.stopLossPct) || p.stopLossPct >= 100) throw new RangeError('stopLossPct must be in (0, 100)');
  if (!finitePos(p.timeStopSeconds)) throw new RangeError('timeStopSeconds must be positive');
  if (!Number.isFinite(p.minScore) || p.minScore < 0 || p.minScore > 100) throw new RangeError('minScore must be in [0, 100]');
  if (!finitePos(p.maxPriceImpactPct)) throw new RangeError('maxPriceImpactPct must be positive');
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > 5_000) throw new RangeError('slippageBps out of range');
  if (!Number.isInteger(p.maxPositionBps) || p.maxPositionBps <= 0 || p.maxPositionBps > 10_000) throw new RangeError('maxPositionBps out of range');
  if (!(p.maxPositionShareOfLiquidity > 0 && p.maxPositionShareOfLiquidity <= 1)) throw new RangeError('maxPositionShareOfLiquidity out of range');
  if (p.tipLamports < 0n || p.minPositionLamports < 0n) throw new RangeError('lamport params must be non-negative');
}

/** Stable identifier of the exact rules plus parameters that produced a trade. */
export function configVersion(presetName: string, p: MomentumParams): string {
  const canonical = JSON.stringify([
    p.name, p.minScore, p.takeProfitPct, p.stopLossPct, p.timeStopSeconds, p.slippageBps, p.tipLamports.toString(),
    p.maxPriceImpactPct, p.minPositionLamports.toString(), p.maxPositionBps, p.maxPositionShareOfLiquidity,
  ]);
  const h = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return `${STRATEGY_VERSION}/${presetName}/${h}`;
}

export type Decision = { ok: true; reason: string } | { ok: false; reason: string };

/** Pre-quote checks that need only the candidate and the time. */
export function screenCandidate(c: Candidate, now: Date, p: MomentumParams): Decision {
  if (!Number.isFinite(c.score)) return { ok: false, reason: 'score is not a number' };
  if (c.score < p.minScore) return { ok: false, reason: `score ${c.score.toFixed(1)} below min ${p.minScore}` };
  const exp = Date.parse(c.expiresAt);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'candidate expiry unparseable' };
  if (exp <= now.getTime()) return { ok: false, reason: 'candidate expired' };
  const obs = Date.parse(c.observedAt);
  if (!Number.isFinite(obs)) return { ok: false, reason: 'candidate observedAt unparseable' };
  if (obs > now.getTime() + 5_000) return { ok: false, reason: 'candidate observed in the future' };
  return { ok: true, reason: `score ${c.score.toFixed(1)} >= ${p.minScore}` };
}

/** Liquidity used for sizing: the lower of the two reported values, so a stale high reading never inflates size. */
export function candidateLiquidityUsd(c: Candidate): number {
  const vals = [c.features?.liquidityUsd, c.safety?.liquidityUsd].filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return vals.length ? Math.min(...vals) : 0;
}

export function liquidityUsdToLamports(liquidityUsd: number, solUsd: number): bigint {
  if (!(liquidityUsd > 0) || !(solUsd > 0) || !Number.isFinite(liquidityUsd) || !Number.isFinite(solUsd)) return 0n;
  return BigInt(Math.floor((liquidityUsd / solUsd) * 1e9));
}

export interface SizingInput {
  equityLamports: bigint;
  /** Token liquidity converted to lamports by the caller. 0 means unknown, which blocks entry. */
  liquidityLamports: bigint;
}

export type SizeDecision =
  | { ok: true; lamports: bigint; positionShareOfLiquidity: number; reason: string }
  | { ok: false; reason: string };

/** size = min(maxPositionBps of equity, maxPositionShareOfLiquidity of liquidity, maxPositionLamports). */
export function sizeEntry(s: SizingInput, p: MomentumParams): SizeDecision {
  if (s.equityLamports <= 0n) return { ok: false, reason: 'no equity' };
  if (s.liquidityLamports <= 0n) return { ok: false, reason: 'liquidity unknown' };
  const byEquity = bpsOf(s.equityLamports, p.maxPositionBps);
  // Share in parts per million so the cap stays in integer math.
  const sharePpm = BigInt(Math.floor(p.maxPositionShareOfLiquidity * 1_000_000));
  const byLiquidity = (s.liquidityLamports * sharePpm) / 1_000_000n;
  let lamports = minBig(byEquity, byLiquidity);
  const absoluteCap = p.maxPositionLamports !== undefined && p.maxPositionLamports < lamports;
  if (absoluteCap) lamports = p.maxPositionLamports!;
  if (lamports < p.minPositionLamports) {
    return { ok: false, reason: `size ${lamports} below minimum ${p.minPositionLamports}` };
  }
  const share = Number(lamports) / Number(s.liquidityLamports);
  const capBy = absoluteCap ? 'absolute cap' : lamports === byEquity ? 'equity cap' : 'liquidity cap';
  return { ok: true, lamports, positionShareOfLiquidity: share, reason: `size ${lamports} by ${capBy}` };
}

export interface EntryQuote { routeOk: boolean; priceImpactPct: number; priceLamportsPerUnit: number }

export function evaluateEntryQuote(q: EntryQuote, p: MomentumParams): Decision {
  if (!q.routeOk) return { ok: false, reason: 'no route' };
  if (!(q.priceLamportsPerUnit > 0) || !Number.isFinite(q.priceLamportsPerUnit)) return { ok: false, reason: 'invalid quote price' };
  if (!Number.isFinite(q.priceImpactPct) || q.priceImpactPct < 0) return { ok: false, reason: 'invalid price impact' };
  if (q.priceImpactPct >= p.maxPriceImpactPct) {
    return { ok: false, reason: `price impact ${q.priceImpactPct.toFixed(3)}% >= cap ${p.maxPriceImpactPct}%` };
  }
  return { ok: true, reason: `impact ${q.priceImpactPct.toFixed(3)}% under cap` };
}

export type EntryDecision =
  | { enter: true; lamports: bigint; positionShareOfLiquidity: number; reason: string }
  | { enter: false; reason: string };

/** Full entry decision. The caller supplies sizing inputs and a buy quote for the sized amount. */
export function decideEntry(args: { candidate: Candidate; now: Date; params: MomentumParams; sizing: SizingInput; quote: EntryQuote }): EntryDecision {
  const s = screenCandidate(args.candidate, args.now, args.params);
  if (!s.ok) return { enter: false, reason: s.reason };
  const z = sizeEntry(args.sizing, args.params);
  if (!z.ok) return { enter: false, reason: z.reason };
  const q = evaluateEntryQuote(args.quote, args.params);
  if (!q.ok) return { enter: false, reason: q.reason };
  return { enter: true, lamports: z.lamports, positionShareOfLiquidity: z.positionShareOfLiquidity, reason: `${s.reason}; ${z.reason}; ${q.reason}` };
}

/** The cost model with the tip the strategy actually pays. */
export function effectiveCostModel(base: CostModel, tipLamports: bigint): CostModel {
  return { ...base, tipLamports };
}

/**
 * Net SOL a sale would return at this quote after venue fee, expected slippage, tip and base fee.
 * May be negative for dust positions.
 */
export function estimateExitNetLamports(tokenAmount: bigint, priceLamportsPerUnit: number, m: CostModel): bigint {
  if (tokenAmount <= 0n || !(priceLamportsPerUnit >= 0) || !Number.isFinite(priceLamportsPerUnit)) {
    return -(m.tipLamports + m.baseFeeLamportsPerSig * BigInt(m.signaturesPerTx));
  }
  return simulateSell(tokenAmount, priceLamportsPerUnit, m).lamportsReceived;
}

export type ExitReason = 'take_profit' | 'stop_loss' | 'time_stop' | 'kill_switch';
export type ExitDecision = { exit: true; reason: ExitReason; detail: string } | { exit: false; detail: string };

function pctToBps(pct: number): bigint { return BigInt(Math.round(pct * 100)); }

/**
 * Exit rules on marked value net of estimated exit costs, compared with the SOL actually spent on entry.
 * Precedence: kill switch, stop-loss, take-profit, time-stop.
 */
export function decideExit(args: {
  entryLamports: bigint;
  openedAt: Date;
  /** Net SOL a sale would return now (estimateExitNetLamports), or null when no quote is available. */
  netExitLamports: bigint | null;
  now: Date;
  params: MomentumParams;
  killSwitch: boolean;
}): ExitDecision {
  const { entryLamports: entry, netExitLamports: net, params: p } = args;
  if (args.killSwitch) return { exit: true, reason: 'kill_switch', detail: 'kill switch engaged' };
  const ageMs = args.now.getTime() - args.openedAt.getTime();
  if (net !== null && entry > 0n) {
    const pnlBps = ((net - entry) * 10_000n) / entry;
    const pnl = `net ${net} vs entry ${entry} (${(Number(pnlBps) / 100).toFixed(2)}%)`;
    if (net * 10_000n <= entry * (10_000n - pctToBps(p.stopLossPct))) {
      return { exit: true, reason: 'stop_loss', detail: `${pnl} <= -${p.stopLossPct}%` };
    }
    if (net * 10_000n >= entry * (10_000n + pctToBps(p.takeProfitPct))) {
      return { exit: true, reason: 'take_profit', detail: `${pnl} >= +${p.takeProfitPct}%` };
    }
    if (ageMs >= p.timeStopSeconds * 1000) {
      return { exit: true, reason: 'time_stop', detail: `held ${Math.floor(ageMs / 1000)}s >= ${p.timeStopSeconds}s; ${pnl}` };
    }
    return { exit: false, detail: `hold: ${pnl}` };
  }
  // No usable mark: only the time-stop can fire, so a position is never held indefinitely.
  if (ageMs >= p.timeStopSeconds * 1000) {
    return { exit: true, reason: 'time_stop', detail: `held ${Math.floor(ageMs / 1000)}s >= ${p.timeStopSeconds}s; no mark` };
  }
  return { exit: false, detail: 'hold: no mark' };
}

/**
 * Idempotency key for a reservation: one entry attempt per (strategy, mint, observation).
 * observedAt is normalized so equivalent ISO spellings map to the same key.
 */
export function entryIdempotencyKey(strategy: string, mint: string, observedAt: string): string {
  const t = Date.parse(observedAt);
  if (!Number.isFinite(t)) throw new RangeError('observedAt unparseable');
  const digest = createHash('sha256').update(JSON.stringify([strategy, mint, new Date(t).toISOString()])).digest('hex');
  return `entry:${strategy}:${digest.slice(0, 40)}`;
}
