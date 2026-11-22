import { describe, expect, it } from 'vitest';
import type { CandidateFeatures, TokenSafety } from '@tidepool/core';
import { buildCandidate, SCORING_VERSION, scoreFeatures } from './scoring.js';
import type { FeatureMeta } from './features.js';

function features(o: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    liquidityUsd: 40_000,
    volume5mUsd: 15_000,
    volumeTrend: 2,
    priceChange5mPct: 5,
    holderCount: 900,
    holderGrowth15m: 0.1,
    mentionVelocity: 1,
    sentiment: 0.4,
    narrativeLabel: 'animal',
    narrativeScore: 0.6,
    boosted: false,
    ...o,
  };
}

const score = (o: Partial<CandidateFeatures>, confirmed = true, flags: string[] = []) =>
  scoreFeatures({ features: features(o), onChainConfirmed: confirmed, narrativeScamFlags: flags }).score;

function nonDecreasing(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v >= values[i - 1]!);
}

describe('scoreFeatures', () => {
  it('is deterministic and records the scoring version', () => {
    const a = scoreFeatures({ features: features(), onChainConfirmed: true });
    const b = scoreFeatures({ features: features(), onChainConfirmed: true });
    expect(a).toEqual(b);
    expect(a.reasons[0]).toBe(`scoring:${SCORING_VERSION}`);
  });

  it('stays within 0..100 for extreme inputs', () => {
    const hi = score({
      liquidityUsd: 1e12,
      volume5mUsd: 1e12,
      volumeTrend: 1e6,
      holderGrowth15m: 100,
      priceChange5mPct: 20,
      mentionVelocity: 1e6,
      sentiment: 1,
      narrativeScore: 1,
    });
    expect(hi).toBeLessThanOrEqual(100);
    expect(hi).toBeGreaterThan(90);
    const lo = score(
      {
        liquidityUsd: 0,
        volume5mUsd: 0,
        volumeTrend: 0,
        holderGrowth15m: -1,
        priceChange5mPct: 500,
        sentiment: -1,
        boosted: true,
      },
      true,
      ['impersonation', 'coordinated_shilling', 'copycat_token', 'urgency_pressure'],
    );
    expect(lo).toBe(0);
    expect(score({ liquidityUsd: Number.NaN, volumeTrend: Number.POSITIVE_INFINITY })).toBeGreaterThanOrEqual(0);
  });

  it('is monotone non-decreasing in liquidity, volume trend, volume level and holder growth', () => {
    expect(
      nonDecreasing([0, 5_000, 10_000, 20_000, 50_000, 150_000, 1e6].map((liquidityUsd) => score({ liquidityUsd }))),
    ).toBe(true);
    expect(nonDecreasing([0, 1, 1.5, 2, 3, 5].map((volumeTrend) => score({ volumeTrend })))).toBe(true);
    expect(nonDecreasing([0, 1_000, 10_000, 25_000, 100_000].map((volume5mUsd) => score({ volume5mUsd })))).toBe(true);
    expect(nonDecreasing([-0.5, 0, 0.05, 0.1, 0.3, 1].map((holderGrowth15m) => score({ holderGrowth15m })))).toBe(true);
    expect(nonDecreasing([0, 0.5, 1, 2, 10].map((mentionVelocity) => score({ mentionVelocity })))).toBe(true);
  });

  it('rewards momentum up to a plateau and penalizes parabolic spikes', () => {
    const at = (p: number) => score({ priceChange5mPct: p });
    expect(at(5)).toBeGreaterThan(at(0));
    expect(at(10)).toBe(at(25));
    expect(at(60)).toBeLessThan(at(25));
    expect(at(100)).toBeLessThan(at(0));
    expect(scoreFeatures({ features: features({ priceChange5mPct: 80 }), onChainConfirmed: true }).reasons).toContain(
      'parabolic_spike_penalty',
    );
  });

  it('gives social and narrative no credit without on-chain confirmation', () => {
    const quiet = score({ mentionVelocity: 0, sentiment: 0, narrativeScore: null }, false);
    const loud = score({ mentionVelocity: 50, sentiment: 1, narrativeScore: 1 }, false);
    expect(loud).toBe(quiet);
    // Confirmation flag alone is not enough when growth or volume is below the thresholds.
    expect(score({ mentionVelocity: 50, holderGrowth15m: 0 }, true)).toBe(
      score({ mentionVelocity: 0, holderGrowth15m: 0 }, true),
    );
  });

  it('penalizes boosted listings, negative sentiment and scam flags', () => {
    const base = score({});
    expect(score({ boosted: true })).toBeLessThan(base);
    expect(score({ sentiment: -0.5 })).toBeLessThan(base);
    expect(score({}, true, ['impersonation'])).toBeLessThan(base);
  });
});

describe('buildCandidate', () => {
  it('sets expiry from the market snapshot time and carries reasons', () => {
    const observedAt = new Date('2026-11-22T12:00:00Z');
    const meta: FeatureMeta = {
      symbol: 'DOG',
      name: 'Dog',
      pairAddress: 'pair',
      priceUsd: 0.001,
      pairCreatedAt: null,
      observedAt,
      onChainConfirmed: true,
      txns5m: 80,
      socialItems: 0,
      socialSuppressed: false,
      narrativeScamFlags: [],
    };
    const safety = { mint: 'm' } as TokenSafety;
    const { candidate } = buildCandidate({
      mint: 'm',
      features: features(),
      meta,
      safety,
      extraReasons: ['x'],
      ttlMs: 90_000,
    });
    expect(candidate.expiresAt).toBe('2026-11-22T12:01:30.000Z');
    expect(candidate.observedAt).toBe(observedAt.toISOString());
    expect(candidate.reasons).toContain('x');
    expect(candidate.reasons[0]).toBe(`scoring:${SCORING_VERSION}`);
  });
});
