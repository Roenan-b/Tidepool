import type { CandidateFeatures } from '@tidepool/core';
import type { SignalEvent } from './types.js';
import { SignalKinds } from './types.js';
import { clamp, toFiniteNumber } from './util.js';

/*
 * Per-token feature computation from recent signals (design doc section 4).
 * - Social items decay exponentially with a configurable half-life, so stale buzz stops counting.
 * - Posts are weighted by account quality; bursts of near-identical text are discounted, heavily so
 *   when they come from new accounts.
 * - Paid DEX Screener boosts never add interest and halve social weight.
 * - Social features can only raise a score when on-chain activity confirms the token: holder
 *   growth, real 5m volume and a minimum trade count. Without confirmation, positive social values
 *   are zeroed (negative sentiment still counts).
 */

export interface FeatureConfig {
  socialHalfLifeMs: number;
  holderGrowthWindowMs: number;
  /** Pair snapshots older than this make the token unscorable (stale market data). */
  maxSnapshotAgeMs: number;
  newAccountAgeDays: number;
  nearDuplicateJaccard: number;
  /** Cluster size at which near-duplicates from new accounts count as a coordinated burst. */
  burstMinSize: number;
  boostedSocialFactor: number;
  /** Weight for symbol-matched aggregate social data, which can match the wrong token. */
  aggregateSocialWeight: number;
  narrativeMaxAgeMs: number;
  confirmation: { minHolderGrowth15m: number; minVolume5mUsd: number; minTxns5m: number };
}

export const DEFAULT_FEATURE_CONFIG: FeatureConfig = {
  socialHalfLifeMs: 10 * 60_000,
  holderGrowthWindowMs: 15 * 60_000,
  maxSnapshotAgeMs: 60_000,
  newAccountAgeDays: 30,
  nearDuplicateJaccard: 0.7,
  burstMinSize: 3,
  boostedSocialFactor: 0.5,
  aggregateSocialWeight: 0.5,
  narrativeMaxAgeMs: 30 * 60_000,
  confirmation: { minHolderGrowth15m: 0.05, minVolume5mUsd: 5_000, minTxns5m: 20 },
};

export interface NarrativeEntry {
  label: string;
  score: number;
  scamFlags: string[];
  scoredAt: Date;
}

export interface FeatureMeta {
  symbol: string;
  name: string;
  pairAddress: string;
  priceUsd: number;
  pairCreatedAt: Date | null;
  observedAt: Date;
  onChainConfirmed: boolean;
  txns5m: number;
  socialItems: number;
  socialSuppressed: boolean;
  narrativeScamFlags: string[];
}

export interface FeatureResult {
  features: CandidateFeatures;
  meta: FeatureMeta;
}

export function decayFactor(ageMs: number, halfLifeMs: number): number {
  if (ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLifeMs);
}

// ---------- Near-duplicate detection ----------

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\w+/g, ' ')
    .replace(/[^a-z0-9$ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Set of hashed word 3-shingles of the normalized text. */
export function shingleHashes(text: string, k = 3): Set<number> {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const out = new Set<number>();
  if (words.length === 0) return out;
  if (words.length < k) {
    out.add(fnv1a(words.join(' ')));
    return out;
  }
  for (let i = 0; i + k <= words.length; i++) out.add(fnv1a(words.slice(i, i + k).join(' ')));
  return out;
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------- Account quality ----------

export interface AccountQuality {
  accountAgeDays?: number | null;
  followers?: number | null;
  following?: number | null;
  verified?: boolean | null;
}

/** Weight in [0.02, 1] from account age and follower ratio; unknown fields get middling weight. */
export function accountQualityWeight(q: AccountQuality | undefined): number {
  const age = q?.accountAgeDays ?? null;
  const ageF = age === null ? 0.5 : age < 7 ? 0.1 : age < 30 ? 0.3 : age < 180 ? 0.7 : 1;
  const followers = q?.followers ?? null;
  const following = q?.following ?? null;
  let ratioF = 0.6;
  if (followers !== null && following !== null) {
    const r = followers / (following + 1);
    ratioF = r < 0.1 ? 0.3 : r < 1 ? 0.6 : 1;
  }
  if (followers !== null && followers < 50) ratioF *= 0.5;
  const verifiedF = q?.verified ? 1.1 : 1;
  return clamp(ageF * ratioF * verifiedF, 0.02, 1);
}

interface Post {
  at: number;
  text: string;
  quality: AccountQuality | undefined;
  sentiment: number | null;
}

function readQuality(v: unknown): AccountQuality | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  return {
    accountAgeDays: toFiniteNumber(o.accountAgeDays),
    followers: toFiniteNumber(o.followers),
    following: toFiniteNumber(o.following),
    verified: typeof o.verified === 'boolean' ? o.verified : null,
  };
}

/** Per-post weights after quality weighting and near-duplicate burst discounting (same order as input). */
export function postWeights(posts: Array<{ at: number; text: string; quality?: AccountQuality }>, cfg: Pick<FeatureConfig, 'nearDuplicateJaccard' | 'burstMinSize' | 'newAccountAgeDays'>): number[] {
  const order = posts.map((_, i) => i).sort((a, b) => posts[a]!.at - posts[b]!.at);
  const hashes = posts.map((p) => shingleHashes(p.text));
  const clusterOf = new Array<number>(posts.length).fill(-1);
  const reps: number[] = [];
  for (const i of order) {
    let assigned = -1;
    for (let c = 0; c < reps.length; c++) {
      if (jaccard(hashes[i]!, hashes[reps[c]!]!) >= cfg.nearDuplicateJaccard) {
        assigned = c;
        break;
      }
    }
    if (assigned === -1) {
      assigned = reps.length;
      reps.push(i);
    }
    clusterOf[i] = assigned;
  }
  const sizes = new Map<number, number>();
  for (const c of clusterOf) sizes.set(c, (sizes.get(c) ?? 0) + 1);
  return posts.map((p, i) => {
    let w = accountQualityWeight(p.quality);
    const k = sizes.get(clusterOf[i]!) ?? 1;
    if (k >= 2 && reps[clusterOf[i]!] !== i) w /= k;
    const age = p.quality?.accountAgeDays ?? null;
    const isNew = age === null || age < cfg.newAccountAgeDays;
    if (k >= cfg.burstMinSize && isNew) w *= 0.1;
    return w;
  });
}

// ---------- Feature computation ----------

function num(v: unknown, fallback = 0): number {
  return toFiniteNumber(v) ?? fallback;
}

export function computeFeatures(
  mint: string,
  signals: readonly SignalEvent[],
  now: Date,
  narrative: NarrativeEntry | null,
  cfg: FeatureConfig = DEFAULT_FEATURE_CONFIG,
): FeatureResult | null {
  const t = now.getTime();
  const mine = signals.filter((s) => s.mint === mint && s.observedAt.getTime() <= t);
  const snapshots = mine.filter((s) => s.kind === SignalKinds.pairSnapshot).sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latest = snapshots[snapshots.length - 1];
  if (!latest || t - latest.observedAt.getTime() > cfg.maxSnapshotAgeMs) return null;
  const lp = latest.payload;
  const priceUsd = num(lp.priceUsd, NaN);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null;

  const liquidityUsd = Math.max(0, num(lp.liquidityUsd));
  const volume5mUsd = Math.max(0, num(lp.volume5mUsd));
  const volume1hUsd = Math.max(0, num(lp.volume1hUsd));
  const txns5m = Math.max(0, num(lp.buys5m)) + Math.max(0, num(lp.sells5m));

  // Volume trend: last 5m vs the average 5m volume observed 5 to 35 minutes ago; fall back to h1.
  const prior = snapshots.filter((s) => {
    const age = t - s.observedAt.getTime();
    return age >= 5 * 60_000 && age <= 35 * 60_000;
  });
  let priorPer5m: number;
  const span = prior.length > 0 ? prior[prior.length - 1]!.observedAt.getTime() - prior[0]!.observedAt.getTime() : 0;
  if (prior.length >= 3 && span >= 10 * 60_000) {
    priorPer5m = prior.reduce((acc, s) => acc + Math.max(0, num(s.payload.volume5mUsd)), 0) / prior.length;
  } else {
    priorPer5m = Math.max(0, volume1hUsd - volume5mUsd) / 11;
  }
  const volumeTrend = priorPer5m > 0 ? clamp(volume5mUsd / priorPer5m, 0, 10) : volume5mUsd > 0 ? 10 : 0;

  // Holder growth over the window.
  const holderSnaps = mine
    .filter((s) => s.kind === SignalKinds.holderSnapshot && toFiniteNumber(s.payload.holderCount) !== null)
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const lastHolder = holderSnaps[holderSnaps.length - 1];
  const holderCount = lastHolder ? Math.max(0, num(lastHolder.payload.holderCount)) : 0;
  let holderGrowth15m = 0;
  if (lastHolder) {
    const windowStart = t - cfg.holderGrowthWindowMs;
    const older = holderSnaps.filter((s) => s.observedAt.getTime() <= windowStart);
    const base = older[older.length - 1] ?? holderSnaps.find((s) => t - s.observedAt.getTime() >= 5 * 60_000);
    if (base && base !== lastHolder) {
      const b = Math.max(1, num(base.payload.holderCount));
      holderGrowth15m = (holderCount - b) / b;
    }
  }

  const boosted = lp.boosted === true || mine.some((s) => s.kind === SignalKinds.boost && t - s.observedAt.getTime() <= 24 * 3600_000);

  // Social: curated posts (quality weighted, burst discounted) plus symbol-matched aggregate metrics.
  const posts: Post[] = mine
    .filter((s) => s.kind === SignalKinds.post)
    .map((s) => ({
      at: s.observedAt.getTime(),
      text: typeof s.payload.text === 'string' ? s.payload.text : '',
      quality: readQuality(s.payload.quality),
      sentiment: toFiniteNumber(s.payload.sentiment),
    }));
  const weights = postWeights(posts, cfg);
  const effectiveWindowMin = cfg.socialHalfLifeMs / Math.LN2 / 60_000;
  let mentionMass = 0;
  let sentNum = 0;
  let sentDen = 0;
  posts.forEach((p, i) => {
    const w = weights[i]! * decayFactor(t - p.at, cfg.socialHalfLifeMs);
    mentionMass += w;
    if (p.sentiment !== null) {
      sentNum += w * clamp(p.sentiment, -1, 1);
      sentDen += w;
    }
  });
  let mentionVelocity = mentionMass / effectiveWindowMin;
  const aggregates = mine.filter((s) => s.kind === SignalKinds.socialMetrics).sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
  const agg = aggregates[0];
  if (agg) {
    const d = decayFactor(t - agg.observedAt.getTime(), cfg.socialHalfLifeMs) * cfg.aggregateSocialWeight;
    mentionVelocity += Math.max(0, num(agg.payload.mentionsPerMinute)) * d;
    const s = toFiniteNumber(agg.payload.sentiment);
    if (s !== null) {
      sentNum += d * clamp(s, -1, 1);
      sentDen += d;
    }
  }
  let sentiment = sentDen > 0 ? clamp(sentNum / sentDen, -1, 1) : 0;
  if (boosted) mentionVelocity *= cfg.boostedSocialFactor;

  const c = cfg.confirmation;
  const onChainConfirmed = holderGrowth15m >= c.minHolderGrowth15m && volume5mUsd >= c.minVolume5mUsd && txns5m >= c.minTxns5m;
  const socialSuppressed = !onChainConfirmed && (mentionVelocity > 0 || sentiment > 0);
  if (!onChainConfirmed) {
    mentionVelocity = 0;
    sentiment = Math.min(0, sentiment);
  }

  const fresh = narrative && t - narrative.scoredAt.getTime() <= cfg.narrativeMaxAgeMs ? narrative : null;

  const pairCreatedMs = toFiniteNumber(lp.pairCreatedAt);
  return {
    features: {
      liquidityUsd,
      volume5mUsd,
      volumeTrend: round(volumeTrend, 4),
      priceChange5mPct: num(lp.priceChange5mPct),
      holderCount,
      holderGrowth15m: round(holderGrowth15m, 4),
      mentionVelocity: round(mentionVelocity, 4),
      sentiment: round(sentiment, 4),
      narrativeLabel: fresh?.label ?? null,
      narrativeScore: fresh ? clamp(fresh.score, 0, 1) : null,
      boosted,
    },
    meta: {
      symbol: typeof lp.symbol === 'string' && lp.symbol ? lp.symbol : mint.slice(0, 6),
      name: typeof lp.name === 'string' ? lp.name : '',
      pairAddress: typeof lp.pairAddress === 'string' ? lp.pairAddress : '',
      priceUsd,
      pairCreatedAt: pairCreatedMs !== null && pairCreatedMs > 0 ? new Date(pairCreatedMs) : null,
      observedAt: latest.observedAt,
      onChainConfirmed,
      txns5m,
      socialItems: posts.length + (agg ? 1 : 0),
      socialSuppressed,
      // Scam flags only lower a score, so they apply even when the narrative score itself is stale.
      narrativeScamFlags: narrative?.scamFlags ?? [],
    },
  };
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
