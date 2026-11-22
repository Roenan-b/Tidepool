import { describe, expect, it, vi } from 'vitest';
import type { Candidate, TokenSafety } from '@tidepool/core';
import type { RiskOfficer, ReservationRequest } from '../contracts.js';
import { withFreshSafety } from './safetyGate.js';
import { toScoutSellQuoter, RpcHealthTracker, SolPriceFeed } from './adapters.js';

const MINT = 'So11111111111111111111111111111111111111112';

function safety(over: Partial<TokenSafety> = {}): TokenSafety {
  return {
    mint: MINT,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    token2022Extensions: [],
    liquidityUsd: 50_000,
    top10HolderShare: 0.2,
    creatorFlagged: false,
    ageSeconds: 7200,
    sellSimulationRatio: null,
    ...over,
  };
}

function request(): ReservationRequest {
  const candidate = {
    mint: MINT,
    symbol: 'X',
    pairAddress: MINT,
    score: 80,
    features: {} as Candidate['features'],
    safety: safety(),
    reasons: [],
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    priceUsd: 1,
  } as Candidate;
  return {
    idempotencyKey: 'k',
    sleeve: 'momentum-v1',
    mint: MINT,
    lamports: 100_000_000n,
    candidate,
    positionShareOfLiquidity: 0.001,
  };
}

function fakeRisk() {
  const reserve = vi.fn(async (_req: ReservationRequest) => ({ approved: false as const, reason: 'test' }));
  const risk = {
    reserve,
    mode: () => 'paper' as const,
    halt: vi.fn(async function (this: unknown) {
      return undefined;
    }),
  } as unknown as RiskOfficer;
  return { risk, reserve };
}

describe('withFreshSafety', () => {
  it('replaces the attached safety facts with a fresh check for the exact size', async () => {
    const { risk, reserve } = fakeRisk();
    const check = vi.fn(async () => safety({ sellSimulationRatio: 0.95 }));
    await withFreshSafety(risk, { check }).reserve(request());
    expect(check).toHaveBeenCalledWith(MINT, 100_000_000n);
    expect(reserve.mock.calls[0]![0].candidate.safety.sellSimulationRatio).toBe(0.95);
  });

  it('vetoes without calling the Risk Officer when the fresh check throws or mismatches', async () => {
    const { risk, reserve } = fakeRisk();
    const failing = withFreshSafety(risk, {
      check: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await failing.reserve(request())).toEqual({ approved: false, reason: 'safety:recheck_failed' });
    const mismatched = withFreshSafety(risk, { check: async () => safety({ mint: 'other' }) });
    expect(await mismatched.reserve(request())).toEqual({ approved: false, reason: 'safety:recheck_mismatch' });
    expect(reserve).not.toHaveBeenCalled();
  });

  it('passes every other method through to the real officer', () => {
    const { risk } = fakeRisk();
    expect(withFreshSafety(risk, { check: async () => safety() }).mode()).toBe('paper');
  });
});

describe('adapters', () => {
  it('converts a round-trip ratio into expected and quoted lamports', async () => {
    const q = toScoutSellQuoter({ quoteSellRatio: async () => 0.93 });
    expect(await q.quoteSell({ mint: MINT, sizeLamports: 1_000_000_000n })).toEqual({
      expectedLamports: 1_000_000_000n,
      quotedLamports: 930_000_000n,
    });
    const none = toScoutSellQuoter({ quoteSellRatio: async () => null });
    expect(await none.quoteSell({ mint: MINT, sizeLamports: 1n })).toBeNull();
  });

  it('reports a SOL price only after a sane quote', async () => {
    const feed = new SolPriceFeed({ quote: async () => ({ outAmount: '151230000' }) as never });
    expect(feed.get()).toBeNull();
    await feed.refresh();
    expect(feed.get()).toBeCloseTo(151.23);
    const bad = new SolPriceFeed({ quote: async () => ({ outAmount: '0' }) as never });
    await bad.refresh();
    expect(bad.get()).toBeNull();
  });

  it('marks RPC unhealthy on a high error rate', () => {
    const h = new RpcHealthTracker();
    expect(h.snapshot().healthy).toBe(false);
    h.record(true);
    expect(h.snapshot().healthy).toBe(true);
    h.record(false);
    h.record(false);
    expect(h.snapshot().healthy).toBe(false);
  });
});

describe('liveSizeCap', () => {
  it('keeps live positions under the signer per-transaction cap', async () => {
    const { liveSizeCap } = await import('./adapters.js');
    expect(liveSizeCap(500_000_000n, 2_000_000n)).toBe(488_000_000n);
    expect(liveSizeCap(5_000_000n, 2_000_000n)).toBe(0n);
  });
});
