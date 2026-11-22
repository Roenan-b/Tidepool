import type { Candidate, CandidateFeatures, TokenSafety } from '@tidepool/core';
import type { FeatureMeta } from './features.js';
import { clamp } from './util.js';

/**
 * Deterministic candidate score, 0..100. Bump SCORING_VERSION whenever any weight, tier or
 * threshold below changes; every candidate records the version in its reasons.
 *
 * Components (maximum points):
 *   liquidity tier        20  tiered on pool liquidity in USD
 *   volume                20  5m volume vs prior average (trend), scaled by absolute 5m volume
 *   holder growth         20  linear up to `holderGrowthFull` over 15 minutes
 *   price momentum        15  linear up to `momentumFullPct`, flat to `parabolicStartPct`,
 *                             then falls to `parabolicPenaltyMax` (negative) at `parabolicEndPct`
 *   social confirmation   15  quality-weighted mention velocity (10) and positive sentiment (5),
 *                             only when on-chain activity confirms the token
 *   narrative             10  cached classifier score, only when fresh and confirmed
 * Penalties: boosted listing, negative sentiment, narrative scam flags.
 */
export const SCORING_VERSION = 'scout-score-v1';

export interface ScoringConfig {
  liquidityTiers: { minUsd: number; points: number }[];
  volumeTrendFull: number;
  volumeLevelFullUsd: number;
  holderGrowthFull: number;
  momentumFullPct: number;
  parabolicStartPct: number;
  parabolicEndPct: number;
  parabolicPenaltyMax: number;
  mentionVelocityFull: number;
  boostedPenalty: number;
  negativeSentimentPenaltyMax: number;
  scamFlagPenalty: number;
  scamFlagPenaltyMax: number;
  /** Confirmation thresholds re-applied here so scoring never trusts social input alone. */
  confirmation: { minHolderGrowth15m: number; minVolume5mUsd: number };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  liquidityTiers: [
    { minUsd: 150_000, points: 20 },
    { minUsd: 50_000, points: 15 },
    { minUsd: 20_000, points: 10 },
    { minUsd: 10_000, points: 5 },
  ],
  volumeTrendFull: 3,
  volumeLevelFullUsd: 25_000,
  holderGrowthFull: 0.3,
  momentumFullPct: 10,
  parabolicStartPct: 30,
  parabolicEndPct: 100,
  parabolicPenaltyMax: -10,
  mentionVelocityFull: 2,
  boostedPenalty: 5,
  negativeSentimentPenaltyMax: 5,
  scamFlagPenalty: 10,
  scamFlagPenaltyMax: 30,
  confirmation: { minHolderGrowth15m: 0.05, minVolume5mUsd: 5_000 },
};

export interface ScoreInput {
  features: CandidateFeatures;
  onChainConfirmed: boolean;
  narrativeScamFlags?: string[];
}

export interface ScoreResult {
  score: number;
  reasons: string[];
  components: Record<string, number>;
}

function r2(x: number): number {
  return Math.round(x * 100) / 100;
}

function finiteOr(x: number, d: number): number {
  return Number.isFinite(x) ? x : d;
}

export function scoreFeatures(input: ScoreInput, cfg: ScoringConfig = DEFAULT_SCORING_CONFIG): ScoreResult {
  const f = input.features;
  const liquidity = finiteOr(f.liquidityUsd, 0);
  const vol5m = finiteOr(f.volume5mUsd, 0);
  const trend = finiteOr(f.volumeTrend, 0);
  const growth = finiteOr(f.holderGrowth15m, 0);
  const pc = finiteOr(f.priceChange5mPct, 0);
  const velocity = finiteOr(f.mentionVelocity, 0);
  const sentiment = clamp(finiteOr(f.sentiment, 0), -1, 1);

  const c: Record<string, number> = {};
  const tier = [...cfg.liquidityTiers].sort((a, b) => b.minUsd - a.minUsd).find((t) => liquidity >= t.minUsd);
  c.liquidity = tier?.points ?? 0;

  const trendPart = clamp((trend - 1) / (cfg.volumeTrendFull - 1), 0, 1);
  const levelPart = clamp(vol5m / cfg.volumeLevelFullUsd, 0, 1);
  c.volume = 20 * trendPart * (0.5 + 0.5 * levelPart);

  c.holderGrowth = 20 * clamp(growth / cfg.holderGrowthFull, 0, 1);

  if (pc <= 0) c.momentum = 0;
  else if (pc <= cfg.momentumFullPct) c.momentum = (15 * pc) / cfg.momentumFullPct;
  else if (pc <= cfg.parabolicStartPct) c.momentum = 15;
  else {
    const over = clamp((pc - cfg.parabolicStartPct) / (cfg.parabolicEndPct - cfg.parabolicStartPct), 0, 1);
    c.momentum = 15 + (cfg.parabolicPenaltyMax - 15) * over;
  }

  const confirmed =
    input.onChainConfirmed && growth >= cfg.confirmation.minHolderGrowth15m && vol5m >= cfg.confirmation.minVolume5mUsd;
  c.social = confirmed ? 10 * clamp(velocity / cfg.mentionVelocityFull, 0, 1) + 5 * Math.max(0, sentiment) : 0;
  c.narrative = confirmed && f.narrativeScore !== null ? 10 * clamp(finiteOr(f.narrativeScore, 0), 0, 1) : 0;

  c.boostedPenalty = f.boosted ? -cfg.boostedPenalty : 0;
  c.sentimentPenalty = sentiment < 0 ? cfg.negativeSentimentPenaltyMax * sentiment : 0;
  const flags = [...new Set(input.narrativeScamFlags ?? [])];
  c.scamPenalty = -Math.min(cfg.scamFlagPenaltyMax, flags.length * cfg.scamFlagPenalty);

  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const score = r2(clamp(total, 0, 100));

  const reasons = [`scoring:${SCORING_VERSION}`];
  for (const [k, v] of Object.entries(c)) if (v !== 0) reasons.push(`${k}:${v > 0 ? '+' : ''}${r2(v)}`);
  if (!confirmed) reasons.push('social_and_narrative_gated:no_onchain_confirmation');
  if (pc > cfg.parabolicStartPct) reasons.push('parabolic_spike_penalty');
  if (f.boosted) reasons.push('boosted_listing');
  for (const flag of flags) reasons.push(`narrative_flag:${flag}`);
  for (const k of Object.keys(c)) c[k] = r2(c[k]!);
  return { score, reasons, components: c };
}

export interface BuildCandidateArgs {
  mint: string;
  features: CandidateFeatures;
  meta: FeatureMeta;
  safety: TokenSafety;
  extraReasons?: string[];
  ttlMs?: number;
  scoring?: ScoringConfig;
}

/** Scores features and assembles the published Candidate. Expiry counts from the market snapshot time. */
export function buildCandidate(a: BuildCandidateArgs): { candidate: Candidate; result: ScoreResult } {
  const result = scoreFeatures(
    { features: a.features, onChainConfirmed: a.meta.onChainConfirmed, narrativeScamFlags: a.meta.narrativeScamFlags },
    a.scoring,
  );
  const observedAt = a.meta.observedAt;
  const candidate: Candidate = {
    mint: a.mint,
    symbol: a.meta.symbol,
    pairAddress: a.meta.pairAddress,
    score: result.score,
    features: a.features,
    safety: a.safety,
    reasons: [...result.reasons, ...(a.extraReasons ?? [])],
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + (a.ttlMs ?? 90_000)).toISOString(),
    priceUsd: a.meta.priceUsd,
  };
  return { candidate, result };
}
