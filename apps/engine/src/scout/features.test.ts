import { describe, expect, it } from 'vitest';
import { accountQualityWeight, computeFeatures, decayFactor, DEFAULT_FEATURE_CONFIG, jaccard, postWeights, shingleHashes } from './features.js';
import { scoreFeatures } from './scoring.js';
import type { SignalEvent } from './types.js';

const MINT = 'So11111111111111111111111111111111111111112';
const NOW = new Date('2026-11-22T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

function snapshot(at: Date, o: Record<string, unknown> = {}): SignalEvent {
  return {
    source: 'dexscreener',
    mint: MINT,
    kind: 'pair_snapshot',
    observedAt: at,
    payload: {
      pairAddress: 'Pair1111111111111111111111111111111111111111',
      symbol: 'DOG',
      name: 'Dog',
      priceUsd: 0.001,
      liquidityUsd: 60_000,
      volume5mUsd: 20_000,
      volume1hUsd: 110_000,
      priceChange5mPct: 5,
      buys5m: 50,
      sells5m: 30,
      boosted: false,
      pairCreatedAt: NOW.getTime() - 3 * 3600_000,
      ...o,
    },
  };
}

const holders = (at: Date, n: number): SignalEvent => ({ source: 'holders', mint: MINT, kind: 'holder_snapshot', observedAt: at, payload: { holderCount: n } });

const post = (at: Date, text: string, quality: Record<string, unknown> = { accountAgeDays: 900, followers: 5_000, following: 300 }): SignalEvent => ({
  source: 'x',
  mint: MINT,
  kind: 'post',
  observedAt: at,
  payload: { text, quality },
});

/** Base signals that satisfy on-chain confirmation: holders 1000 -> 1200 over 15 minutes, 20k volume, 80 trades. */
const confirmed = (): SignalEvent[] => [holders(ago(16 * MIN), 1000), holders(ago(1_000), 1200), snapshot(ago(2_000))];

describe('decay and near-duplicate helpers', () => {
  it('halves weight at each half-life', () => {
    expect(decayFactor(0, 600_000)).toBe(1);
    expect(decayFactor(600_000, 600_000)).toBeCloseTo(0.5);
    expect(decayFactor(1_800_000, 600_000)).toBeCloseTo(0.125);
  });

  it('detects near-duplicate text after normalization', () => {
    const a = shingleHashes('Huge news!! $DOG is going to the MOON https://t.co/abc @someone');
    const b = shingleHashes('huge news $dog is going to the moon');
    const c = shingleHashes('Liquidity just migrated to the AMM, watching holder distribution');
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, c)).toBeLessThan(0.2);
  });

  it('weights established accounts above new ones', () => {
    expect(accountQualityWeight({ accountAgeDays: 1000, followers: 10_000, following: 100 })).toBe(1);
    expect(accountQualityWeight({ accountAgeDays: 2, followers: 10, following: 900 })).toBeLessThan(0.05);
  });
});

describe('computeFeatures', () => {
  it('returns null without a fresh pair snapshot', () => {
    expect(computeFeatures(MINT, [], NOW, null)).toBeNull();
    expect(computeFeatures(MINT, [snapshot(ago(2 * MIN))], NOW, null)).toBeNull();
  });

  it('computes market, holder and trend features', () => {
    const r = computeFeatures(MINT, confirmed(), NOW, null)!;
    expect(r.features.liquidityUsd).toBe(60_000);
    expect(r.features.holderCount).toBe(1200);
    expect(r.features.holderGrowth15m).toBeCloseTo(0.2);
    // Fallback trend: 20k / ((110k - 20k) / 11).
    expect(r.features.volumeTrend).toBeCloseTo(20_000 / (90_000 / 11), 3);
    expect(r.meta.onChainConfirmed).toBe(true);
  });

  it('decays social mentions with time', () => {
    const fresh = computeFeatures(MINT, [...confirmed(), post(ago(0), 'first unique post about the token')], NOW, null)!;
    const old = computeFeatures(MINT, [...confirmed(), post(ago(20 * MIN), 'first unique post about the token')], NOW, null)!;
    expect(old.features.mentionVelocity).toBeCloseTo(fresh.features.mentionVelocity * 0.25, 4);
  });

  it('discounts bursts of near-identical posts from new accounts', () => {
    const newAcct = { accountAgeDays: 3, followers: 20, following: 500 };
    const burst = Array.from({ length: 6 }, (_, i) => post(ago(i * 1000), `$DOG to the moon now buy buy buy ${i % 2 ? '!!' : ''}`, newAcct));
    const organic = [
      'Liquidity migrated cleanly and holders keep spreading',
      'Volume on the AMM is up and the dev wallet is empty',
      'Looked at the chart, steady buyers with no single whale',
      'Community call tonight went well, real people in voice',
      'The meme itself is funny, posting it in the group chat',
      'Holder count crossed a thousand which is a good sign',
    ].map((t, i) => post(ago(i * 1000), t));
    const b = computeFeatures(MINT, [...confirmed(), ...burst], NOW, null)!;
    const o = computeFeatures(MINT, [...confirmed(), ...organic], NOW, null)!;
    expect(b.features.mentionVelocity).toBeLessThan(o.features.mentionVelocity / 50);
    const w = postWeights(
      burst.map((s) => ({ at: s.observedAt.getTime(), text: s.payload.text as string, quality: newAcct })),
      DEFAULT_FEATURE_CONFIG,
    );
    expect(Math.max(...w)).toBeLessThan(0.01);
  });

  it('marks boosted listings and halves their social weight', () => {
    const posts = [post(ago(0), 'a genuinely distinct observation about the pool')];
    const plain = computeFeatures(MINT, [...confirmed(), ...posts], NOW, null)!;
    const boost: SignalEvent = { source: 'dexscreener', mint: MINT, kind: 'boost', observedAt: ago(5 * MIN), payload: { boosted: true } };
    const boosted = computeFeatures(MINT, [...confirmed(), ...posts, boost], NOW, null)!;
    expect(boosted.features.boosted).toBe(true);
    expect(boosted.features.mentionVelocity).toBeCloseTo(plain.features.mentionVelocity / 2, 3);
    const s1 = scoreFeatures({ features: plain.features, onChainConfirmed: true }).score;
    const s2 = scoreFeatures({ features: boosted.features, onChainConfirmed: true }).score;
    expect(s2).toBeLessThan(s1);
  });

  it('does not let social activity raise the score without on-chain confirmation', () => {
    const unconfirmed = [holders(ago(16 * MIN), 1000), holders(ago(1_000), 1000), snapshot(ago(2_000))];
    const hype = Array.from({ length: 20 }, (_, i) => post(ago(i * 1000), `distinct analysis number ${i} with different words ${'x'.repeat(i)}`));
    const lunar: SignalEvent = { source: 'lunarcrush', mint: MINT, kind: 'social_metrics', observedAt: ago(0), payload: { mentionsPerMinute: 50, sentiment: 0.9 } };
    const quiet = computeFeatures(MINT, unconfirmed, NOW, null)!;
    const loud = computeFeatures(MINT, [...unconfirmed, ...hype, lunar], NOW, null)!;
    expect(loud.meta.onChainConfirmed).toBe(false);
    expect(loud.meta.socialSuppressed).toBe(true);
    expect(loud.features.mentionVelocity).toBe(0);
    expect(loud.features.sentiment).toBe(0);
    const narrative = { label: 'animal', score: 1, scamFlags: [], scoredAt: ago(MIN) };
    const loudN = computeFeatures(MINT, [...unconfirmed, ...hype, lunar], NOW, narrative)!;
    const sQuiet = scoreFeatures({ features: quiet.features, onChainConfirmed: quiet.meta.onChainConfirmed }).score;
    const sLoud = scoreFeatures({ features: loudN.features, onChainConfirmed: loudN.meta.onChainConfirmed }).score;
    expect(sLoud).toBe(sQuiet);

    // The same social input does raise the score once the token is confirmed on-chain.
    const c = computeFeatures(MINT, [...confirmed(), ...hype, lunar], NOW, narrative)!;
    const cBase = computeFeatures(MINT, confirmed(), NOW, null)!;
    expect(scoreFeatures({ features: c.features, onChainConfirmed: true }).score).toBeGreaterThan(scoreFeatures({ features: cBase.features, onChainConfirmed: true }).score);
  });

  it('still applies negative sentiment without confirmation', () => {
    const unconfirmed = [snapshot(ago(2_000), { volume5mUsd: 100, buys5m: 1, sells5m: 1 })];
    const lunar: SignalEvent = { source: 'lunarcrush', mint: MINT, kind: 'social_metrics', observedAt: ago(0), payload: { mentionsPerMinute: 5, sentiment: -0.8 } };
    expect(computeFeatures(MINT, [...unconfirmed, lunar], NOW, null)!.features.sentiment).toBeCloseTo(-0.8);
  });

  it('ignores stale narrative scores but keeps their scam flags', () => {
    const stale = { label: 'animal', score: 0.9, scamFlags: ['impersonation'], scoredAt: ago(2 * 3600_000) };
    const r = computeFeatures(MINT, confirmed(), NOW, stale)!;
    expect(r.features.narrativeScore).toBeNull();
    expect(r.meta.narrativeScamFlags).toEqual(['impersonation']);
  });
});
