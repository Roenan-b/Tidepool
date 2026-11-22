import { describe, expect, it } from 'vitest';
import { COST_MODELS, simulateBuy, simulateSell, txOverheadLamports } from '@tidepool/core';
import { PaperBroker } from './paperBroker.js';
import { MINT_A } from './testkit.js';
import type { QuoteResult, QuoteSource } from './types.js';

class FixedQuotes implements QuoteSource {
  constructor(public r: QuoteResult) {}
  async quote(): Promise<QuoteResult> {
    return this.r;
  }
}

const tip = 500_000n;

describe('PaperBroker', () => {
  it('buy fills match the core cost model with the strategy tip', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({ priceLamportsPerUnit: 0.002, priceImpactPct: 0.4, routeOk: true }),
      failureRate: 0,
    });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 500_000_000n, slippageBps: 150, tipLamports: tip, ticket: null });
    const expected = simulateBuy(500_000_000n, 0.002, { ...COST_MODELS.graduated, tipLamports: tip });
    expect(r).toEqual({
      ok: true,
      lamportsSpent: expected.lamportsSpent,
      tokenAmount: expected.tokenAmount,
      signature: null,
    });
    expect(b.costs.tipLamports).toBe(tip);
    expect(b.costs.venueFeeLamports).toBe(1_500_000n); // 30 bps of 0.5 SOL
  });

  it('sell fills match the core cost model', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({ priceLamportsPerUnit: 0.0021, priceImpactPct: 0.4, routeOk: true }),
      failureRate: 0,
    });
    const r = await b.sell({
      mint: MINT_A,
      tokenAmount: 240_000_000_000n,
      slippageBps: 150,
      tipLamports: tip,
      ticket: null,
    });
    const expected = simulateSell(240_000_000_000n, 0.0021, { ...COST_MODELS.graduated, tipLamports: tip });
    expect(r).toEqual({ ok: true, lamportsReceived: expected.lamportsReceived, signature: null });
  });

  it('uses the bonding-curve model when the quote reports that venue', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({
        priceLamportsPerUnit: 0.002,
        priceImpactPct: 0.4,
        routeOk: true,
        venue: 'bondingCurve',
      }),
      failureRate: 0,
    });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 100_000_000n, slippageBps: 150, tipLamports: tip, ticket: null });
    expect(r.ok && r.tokenAmount).toBe(
      simulateBuy(100_000_000n, 0.002, { ...COST_MODELS.bondingCurve, tipLamports: tip }).tokenAmount,
    );
    expect(b.costModelFor(MINT_A).venueFeeBps).toBe(125);
  });

  it('seeded failures are reproducible and burn base fee plus tip', async () => {
    const run = async () => {
      const b = new PaperBroker({
        quotes: new FixedQuotes({ priceLamportsPerUnit: 0.002, priceImpactPct: 0.4, routeOk: true }),
        failureRate: 0.5,
        seed: 7,
      });
      const out: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = await b.buy({
          mint: MINT_A,
          lamportsIn: 100_000_000n,
          slippageBps: 150,
          tipLamports: tip,
          ticket: null,
        });
        out.push(r.ok ? 'ok' : `fail:${r.burnedFeeLamports}`);
      }
      return { out, costs: b.costs };
    };
    const a = await run();
    const c = await run();
    expect(a.out).toEqual(c.out);
    const failures = a.out.filter((x) => x.startsWith('fail')).length;
    expect(failures).toBeGreaterThan(5);
    expect(failures).toBeLessThan(35);
    const burn = txOverheadLamports({ ...COST_MODELS.graduated, tipLamports: tip });
    expect(a.out.filter((x) => x.startsWith('fail')).every((x) => x === `fail:${burn}`)).toBe(true);
    expect(a.costs.failedTxBurnLamports).toBe(burn * BigInt(failures));
    expect(a.costs.failures).toBe(failures);
  });

  it('a different seed gives a different failure sequence', async () => {
    const seq = async (seed: number) => {
      const b = new PaperBroker({
        quotes: new FixedQuotes({ priceLamportsPerUnit: 0.002, priceImpactPct: 0.4, routeOk: true }),
        failureRate: 0.5,
        seed,
      });
      const out: boolean[] = [];
      for (let i = 0; i < 30; i++)
        out.push(
          (await b.buy({ mint: MINT_A, lamportsIn: 10_000_000n, slippageBps: 150, tipLamports: tip, ticket: null })).ok,
        );
      return out.join();
    };
    expect(await seq(1)).not.toBe(await seq(2));
  });

  it('fails with a fee burn when expected slippage exceeds the allowed slippage', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({ priceLamportsPerUnit: 0.002, priceImpactPct: 0.4, routeOk: true }),
      failureRate: 0,
    });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 100_000_000n, slippageBps: 50, tipLamports: tip, ticket: null });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.burnedFeeLamports).toBe(tip + 5_000n);
  });

  it('no route costs nothing', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({ priceLamportsPerUnit: 0, priceImpactPct: 0, routeOk: false }),
      failureRate: 0,
    });
    expect(
      await b.sell({ mint: MINT_A, tokenAmount: 1000n, slippageBps: 150, tipLamports: tip, ticket: null }),
    ).toEqual({ ok: false, error: 'no route', burnedFeeLamports: 0n });
  });

  it('a throwing quote source becomes a costless failure', async () => {
    const b = new PaperBroker({
      quotes: {
        quote: async () => {
          throw new Error('down');
        },
      },
      failureRate: 0,
    });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: tip, ticket: null });
    expect(r).toMatchObject({ ok: false, burnedFeeLamports: 0n });
  });

  it('counts price impact when the source reports a mid price', async () => {
    const b = new PaperBroker({
      quotes: new FixedQuotes({
        priceLamportsPerUnit: 0.0021,
        midPriceLamportsPerUnit: 0.002,
        priceImpactPct: 5,
        routeOk: true,
      }),
      failureRate: 0,
    });
    await b.buy({ mint: MINT_A, lamportsIn: 100_000_000n, slippageBps: 150, tipLamports: tip, ticket: null });
    expect(b.costs.priceImpactLamports).toBeGreaterThan(0n);
    expect(b.costs.slippageLamports).toBeGreaterThan(0n);
  });
});
