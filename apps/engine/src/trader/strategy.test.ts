import { describe, expect, it } from 'vitest';
import { COST_MODELS, getPreset, simulateSell } from '@tidepool/core';
import {
  configVersion,
  decideEntry,
  decideExit,
  effectiveCostModel,
  entryIdempotencyKey,
  estimateExitNetLamports,
  evaluateEntryQuote,
  liquidityUsdToLamports,
  momentumParams,
  screenCandidate,
  sizeEntry,
  STRATEGY_VERSION,
} from './strategy.js';
import { makeCandidate, MINT_A, MINT_B } from './testkit.js';

const now = new Date('2026-11-01T00:00:00Z');
const balanced = momentumParams(getPreset('balanced'));

describe('params', () => {
  it('derives limits from the preset and validates', () => {
    expect(balanced.minScore).toBe(70);
    expect(balanced.maxPositionBps).toBe(500);
    expect(balanced.maxPositionShareOfLiquidity).toBe(0.01);
    expect(() => momentumParams(getPreset('balanced'), { stopLossPct: 0 })).toThrow();
    expect(() => momentumParams(getPreset('balanced'), { maxPositionBps: 20_000 })).toThrow();
  });

  it('configVersion is stable and changes with params', () => {
    const a = configVersion('balanced', balanced);
    expect(a).toBe(configVersion('balanced', momentumParams(getPreset('balanced'))));
    expect(a.startsWith(STRATEGY_VERSION)).toBe(true);
    expect(configVersion('balanced', momentumParams(getPreset('balanced'), { takeProfitPct: 20 }))).not.toBe(a);
  });
});

describe('screenCandidate', () => {
  it('accepts score exactly at the minimum and rejects just below', () => {
    expect(screenCandidate(makeCandidate({ score: 70 }), now, balanced).ok).toBe(true);
    const r = screenCandidate(makeCandidate({ score: 69.99 }), now, balanced);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/below min/);
  });

  it('rejects a candidate expiring exactly now, accepts one expiring 1 ms later', () => {
    expect(screenCandidate(makeCandidate({ expiresAt: now.toISOString() }), now, balanced).ok).toBe(false);
    expect(
      screenCandidate(makeCandidate({ expiresAt: new Date(now.getTime() + 1).toISOString() }), now, balanced).ok,
    ).toBe(true);
  });

  it('rejects unparseable times', () => {
    expect(screenCandidate(makeCandidate({ expiresAt: 'nope' }), now, balanced).ok).toBe(false);
    expect(screenCandidate(makeCandidate({ observedAt: 'nope' }), now, balanced).ok).toBe(false);
  });
});

describe('sizeEntry', () => {
  it('takes the equity cap when liquidity is deep', () => {
    const r = sizeEntry({ equityLamports: 10_000_000_000n, liquidityLamports: 1_000_000_000_000n }, balanced);
    expect(r).toMatchObject({ ok: true, lamports: 500_000_000n });
  });

  it('takes the liquidity cap when liquidity is thin', () => {
    const r = sizeEntry({ equityLamports: 10_000_000_000n, liquidityLamports: 20_000_000_000n }, balanced);
    expect(r.ok && r.lamports).toBe(200_000_000n);
    expect(r.ok && r.positionShareOfLiquidity).toBeCloseTo(0.01, 10);
  });

  it('enforces the minimum position at the boundary', () => {
    const p = momentumParams(getPreset('balanced'), { minPositionLamports: 500_000_000n });
    expect(sizeEntry({ equityLamports: 10_000_000_000n, liquidityLamports: 10n ** 15n }, p).ok).toBe(true);
    expect(sizeEntry({ equityLamports: 9_999_999_999n, liquidityLamports: 10n ** 15n }, p).ok).toBe(false);
  });

  it('blocks unknown liquidity and zero equity', () => {
    expect(sizeEntry({ equityLamports: 10n ** 10n, liquidityLamports: 0n }, balanced).ok).toBe(false);
    expect(sizeEntry({ equityLamports: 0n, liquidityLamports: 10n ** 12n }, balanced).ok).toBe(false);
  });

  it('converts liquidity USD to lamports', () => {
    expect(liquidityUsdToLamports(150_000, 150)).toBe(1_000_000_000_000n);
    expect(liquidityUsdToLamports(150_000, 0)).toBe(0n);
  });
});

describe('evaluateEntryQuote', () => {
  it('rejects impact at the cap and accepts just under', () => {
    expect(evaluateEntryQuote({ routeOk: true, priceImpactPct: 2, priceLamportsPerUnit: 1 }, balanced).ok).toBe(false);
    expect(evaluateEntryQuote({ routeOk: true, priceImpactPct: 1.999, priceLamportsPerUnit: 1 }, balanced).ok).toBe(
      true,
    );
  });
  it('rejects no route and invalid numbers', () => {
    expect(evaluateEntryQuote({ routeOk: false, priceImpactPct: 0, priceLamportsPerUnit: 1 }, balanced).ok).toBe(false);
    expect(
      evaluateEntryQuote({ routeOk: true, priceImpactPct: Number.NaN, priceLamportsPerUnit: 1 }, balanced).ok,
    ).toBe(false);
    expect(evaluateEntryQuote({ routeOk: true, priceImpactPct: 0.1, priceLamportsPerUnit: 0 }, balanced).ok).toBe(
      false,
    );
  });
});

describe('decideEntry', () => {
  it('combines every check and reports a reason', () => {
    const d = decideEntry({
      candidate: makeCandidate(),
      now,
      params: balanced,
      sizing: { equityLamports: 10n ** 10n, liquidityLamports: 10n ** 13n },
      quote: { routeOk: true, priceImpactPct: 0.5, priceLamportsPerUnit: 1 },
    });
    expect(d.enter).toBe(true);
    expect(d.reason).toMatch(/score/);
    const veto = decideEntry({
      candidate: makeCandidate({ score: 10 }),
      now,
      params: balanced,
      sizing: { equityLamports: 10n ** 10n, liquidityLamports: 10n ** 13n },
      quote: { routeOk: true, priceImpactPct: 0.5, priceLamportsPerUnit: 1 },
    });
    expect(veto).toEqual({ enter: false, reason: expect.stringMatching(/below min/) });
  });
});

describe('decideExit', () => {
  const entry = 1_000_000_000n;
  const openedAt = new Date(now.getTime() - 60_000);
  const base = { entryLamports: entry, openedAt, now, params: balanced, killSwitch: false };

  it('take-profit fires exactly at +14% net and not 1 lamport below', () => {
    expect(decideExit({ ...base, netExitLamports: 1_140_000_000n })).toMatchObject({
      exit: true,
      reason: 'take_profit',
    });
    expect(decideExit({ ...base, netExitLamports: 1_139_999_999n }).exit).toBe(false);
  });

  it('stop-loss fires exactly at -8% net and not 1 lamport above', () => {
    expect(decideExit({ ...base, netExitLamports: 920_000_000n })).toMatchObject({ exit: true, reason: 'stop_loss' });
    expect(decideExit({ ...base, netExitLamports: 920_000_001n }).exit).toBe(false);
  });

  it('time-stop fires at exactly timeStopSeconds, not 1 ms before', () => {
    const t = balanced.timeStopSeconds * 1000;
    expect(decideExit({ ...base, netExitLamports: entry, openedAt: new Date(now.getTime() - t) })).toMatchObject({
      exit: true,
      reason: 'time_stop',
    });
    expect(decideExit({ ...base, netExitLamports: entry, openedAt: new Date(now.getTime() - t + 1) }).exit).toBe(false);
  });

  it('kill switch takes precedence over everything', () => {
    expect(decideExit({ ...base, netExitLamports: 2_000_000_000n, killSwitch: true })).toMatchObject({
      exit: true,
      reason: 'kill_switch',
    });
  });

  it('stop-loss takes precedence over time-stop', () => {
    expect(decideExit({ ...base, netExitLamports: 500_000_000n, openedAt: new Date(0) })).toMatchObject({
      reason: 'stop_loss',
    });
  });

  it('without a mark only the time-stop can fire', () => {
    expect(decideExit({ ...base, netExitLamports: null }).exit).toBe(false);
    expect(decideExit({ ...base, netExitLamports: null, openedAt: new Date(0) })).toMatchObject({
      exit: true,
      reason: 'time_stop',
    });
  });

  it('accounts for exit costs: +15% gross is below +14% net after costs', () => {
    const m = effectiveCostModel(COST_MODELS.bondingCurve, balanced.tipLamports);
    const tokens = 1_000_000_000n;
    const price = 1.15; // gross value 1.15 SOL against a 1 SOL entry
    const net = estimateExitNetLamports(tokens, price, m);
    expect(net).toBe(simulateSell(tokens, price, m).lamportsReceived);
    expect(net).toBeLessThan(1_140_000_000n);
    expect(decideExit({ ...base, netExitLamports: net }).exit).toBe(false);
    // The same gross on a cost-free model would take profit, so the costs made the difference.
    const free = { ...m, venueFeeBps: 0, slippageBps: 0, tipLamports: 0n, baseFeeLamportsPerSig: 0n };
    expect(decideExit({ ...base, netExitLamports: estimateExitNetLamports(tokens, price, free) }).exit).toBe(true);
  });

  it('is deterministic', () => {
    const a = decideExit({ ...base, netExitLamports: 1_050_000_000n });
    const b = decideExit({ ...base, netExitLamports: 1_050_000_000n });
    expect(a).toEqual(b);
  });
});

describe('entryIdempotencyKey', () => {
  it('is stable across equivalent ISO spellings and distinct per mint and time', () => {
    const k1 = entryIdempotencyKey('momentum-v1', MINT_A, '2026-11-01T00:00:00Z');
    expect(k1).toBe(entryIdempotencyKey('momentum-v1', MINT_A, '2026-11-01T00:00:00.000Z'));
    expect(k1).not.toBe(entryIdempotencyKey('momentum-v1', MINT_B, '2026-11-01T00:00:00Z'));
    expect(k1).not.toBe(entryIdempotencyKey('momentum-v1', MINT_A, '2026-11-01T00:00:01Z'));
    expect(k1).not.toBe(entryIdempotencyKey('other', MINT_A, '2026-11-01T00:00:00Z'));
    expect(() => entryIdempotencyKey('momentum-v1', MINT_A, 'bad')).toThrow();
  });
});

describe('sizeEntry absolute cap', () => {
  it('never sizes above maxPositionLamports', () => {
    const p = momentumParams(getPreset('aggressive'), { maxPositionLamports: 100_000_000n });
    const d = sizeEntry({ equityLamports: 1_000_000_000_000n, liquidityLamports: 1_000_000_000_000n }, p);
    expect(d).toMatchObject({ ok: true, lamports: 100_000_000n });
    if (d.ok) expect(d.reason).toContain('absolute cap');
  });
});
