/**
 * Paper execution venue. Prices come from a real quote source (Jupiter in paper mode, fixtures in tests and
 * the backtest); fills are computed with the core cost model, so paper results carry venue fees, expected
 * slippage, tips, base fees and a seeded rate of failed transactions that still burn fees.
 */
import { COST_MODELS, bpsOf, simulateBuy, simulateSell, txOverheadLamports, type CostModel } from '@tidepool/core';
import type { SignedTicket } from '@tidepool/core/ticket';
import type { Broker } from '../contracts.js';
import { createRng, type Rng } from './rng.js';
import { errorText, type QuoteResult, type QuoteSource, type Venue } from './types.js';

export interface PaperCostTotals {
  venueFeeLamports: bigint;
  slippageLamports: bigint;
  /** Only counted when the quote source reports a mid price (fixtures, backtest). */
  priceImpactLamports: bigint;
  tipLamports: bigint;
  baseFeeLamports: bigint;
  failedTxBurnLamports: bigint;
  fills: number;
  failures: number;
}

export function emptyCostTotals(): PaperCostTotals {
  return { venueFeeLamports: 0n, slippageLamports: 0n, priceImpactLamports: 0n, tipLamports: 0n, baseFeeLamports: 0n, failedTxBurnLamports: 0n, fills: 0, failures: 0 };
}

export interface PaperBrokerOptions {
  quotes: QuoteSource;
  costModels?: Record<Venue, CostModel>;
  /** Venue used when the quote does not report one and no earlier quote did. */
  defaultVenue?: Venue;
  /** Overrides each cost model's failureRate when set (0..1). */
  failureRate?: number;
  /** Seed for the failure RNG. Same seed and same call sequence give the same fills. */
  seed?: number;
  rng?: Rng;
  /** Max mints whose venue is remembered (bounded cache). */
  maxVenueCache?: number;
}

type BuyResult = Awaited<ReturnType<Broker['buy']>>;
type SellResult = Awaited<ReturnType<Broker['sell']>>;

const nonNeg = (v: bigint) => (v > 0n ? v : 0n);

export class PaperBroker implements Broker {
  readonly mode = 'paper' as const;
  readonly costs: PaperCostTotals = emptyCostTotals();
  private readonly quotes: QuoteSource;
  private readonly models: Record<Venue, CostModel>;
  private readonly defaultVenue: Venue;
  private readonly failureRate: number | undefined;
  private readonly rng: Rng;
  private readonly venues = new Map<string, Venue>();
  private readonly maxVenueCache: number;

  constructor(opts: PaperBrokerOptions) {
    this.quotes = opts.quotes;
    this.models = opts.costModels ?? COST_MODELS;
    this.defaultVenue = opts.defaultVenue ?? 'graduated';
    if (opts.failureRate !== undefined && !(opts.failureRate >= 0 && opts.failureRate <= 1)) throw new RangeError('failureRate must be in [0, 1]');
    this.failureRate = opts.failureRate;
    this.rng = opts.rng ?? createRng(opts.seed ?? 1);
    this.maxVenueCache = opts.maxVenueCache ?? 10_000;
  }

  /** Cost model for a mint: the venue last reported by a quote, else the default. Use it for the Trader's exit estimates too. */
  costModelFor(mint: string): CostModel {
    return this.models[this.venues.get(mint) ?? this.defaultVenue];
  }

  private rememberVenue(mint: string, q: QuoteResult): void {
    if (!q.venue) return;
    if (!this.venues.has(mint) && this.venues.size >= this.maxVenueCache) {
      const oldest = this.venues.keys().next().value;
      if (oldest !== undefined) this.venues.delete(oldest);
    }
    this.venues.set(mint, q.venue);
  }

  private modelWithTip(mint: string, tipLamports: bigint): CostModel {
    const base = this.costModelFor(mint);
    return { ...base, tipLamports, failureRate: this.failureRate ?? base.failureRate };
  }

  async quote(mint: string, side: 'buy' | 'sell', amount: bigint) {
    const q = await this.quotes.quote(mint, side, amount);
    this.rememberVenue(mint, q);
    return { priceLamportsPerUnit: q.priceLamportsPerUnit, priceImpactPct: q.priceImpactPct, routeOk: q.routeOk };
  }

  /** Returns a failure if the simulated transaction does not land, booking the burned fee. */
  private maybeFail(m: CostModel, allowedSlippageBps: number): { ok: false; error: string; burnedFeeLamports: bigint } | null {
    let error: string | null = null;
    if (m.slippageBps > allowedSlippageBps) error = `paper: expected slippage ${m.slippageBps} bps exceeds limit ${allowedSlippageBps} bps`;
    // Draw on every call so the sequence of random numbers does not depend on the slippage branch.
    const roll = this.rng();
    if (!error && roll < m.failureRate) error = 'paper: simulated transaction failure';
    if (!error) return null;
    const burned = txOverheadLamports(m);
    this.costs.failedTxBurnLamports += burned;
    this.costs.failures += 1;
    return { ok: false, error, burnedFeeLamports: burned };
  }

  private bookOverhead(m: CostModel): void {
    this.costs.tipLamports += m.tipLamports;
    this.costs.baseFeeLamports += m.baseFeeLamportsPerSig * BigInt(m.signaturesPerTx);
    this.costs.fills += 1;
  }

  async buy(args: { mint: string; lamportsIn: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<BuyResult> {
    if (args.lamportsIn <= 0n) return { ok: false, error: 'lamportsIn must be positive', burnedFeeLamports: 0n };
    if (args.tipLamports < 0n) return { ok: false, error: 'tip must be non-negative', burnedFeeLamports: 0n };
    let q: QuoteResult;
    try {
      q = await this.quotes.quote(args.mint, 'buy', args.lamportsIn);
    } catch (err) {
      return { ok: false, error: `quote failed: ${errorText(err)}`, burnedFeeLamports: 0n };
    }
    this.rememberVenue(args.mint, q);
    if (!q.routeOk || !(q.priceLamportsPerUnit > 0)) return { ok: false, error: 'no route', burnedFeeLamports: 0n };
    const m = this.modelWithTip(args.mint, args.tipLamports);
    const fail = this.maybeFail(m, args.slippageBps);
    if (fail) return fail;
    const fill = simulateBuy(args.lamportsIn, q.priceLamportsPerUnit, m);
    if (fill.tokenAmount <= 0n) return { ok: false, error: 'fill below one token unit', burnedFeeLamports: 0n };
    const venueFee = bpsOf(args.lamportsIn, m.venueFeeBps);
    const afterFee = args.lamportsIn - venueFee;
    const atQuote = BigInt(Math.floor(Number(fill.tokenAmount) * q.priceLamportsPerUnit));
    this.costs.venueFeeLamports += venueFee;
    this.costs.slippageLamports += nonNeg(afterFee - atQuote);
    if (q.midPriceLamportsPerUnit !== undefined && q.midPriceLamportsPerUnit > 0) {
      const atMid = BigInt(Math.floor(Number(fill.tokenAmount) * q.midPriceLamportsPerUnit));
      this.costs.priceImpactLamports += nonNeg(atQuote - atMid);
    }
    this.bookOverhead(m);
    return { ok: true, lamportsSpent: fill.lamportsSpent, tokenAmount: fill.tokenAmount, signature: null };
  }

  async sell(args: { mint: string; tokenAmount: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<SellResult> {
    if (args.tokenAmount <= 0n) return { ok: false, error: 'tokenAmount must be positive', burnedFeeLamports: 0n };
    if (args.tipLamports < 0n) return { ok: false, error: 'tip must be non-negative', burnedFeeLamports: 0n };
    let q: QuoteResult;
    try {
      q = await this.quotes.quote(args.mint, 'sell', args.tokenAmount);
    } catch (err) {
      return { ok: false, error: `quote failed: ${errorText(err)}`, burnedFeeLamports: 0n };
    }
    this.rememberVenue(args.mint, q);
    if (!q.routeOk || !(q.priceLamportsPerUnit >= 0)) return { ok: false, error: 'no route', burnedFeeLamports: 0n };
    const m = this.modelWithTip(args.mint, args.tipLamports);
    const fail = this.maybeFail(m, args.slippageBps);
    if (fail) return fail;
    const fill = simulateSell(args.tokenAmount, q.priceLamportsPerUnit, m);
    const atQuote = BigInt(Math.floor(Number(args.tokenAmount) * q.priceLamportsPerUnit));
    const grossFill = BigInt(Math.floor(Number(args.tokenAmount) * fill.effectivePrice));
    this.costs.venueFeeLamports += bpsOf(grossFill, m.venueFeeBps);
    this.costs.slippageLamports += nonNeg(atQuote - grossFill);
    if (q.midPriceLamportsPerUnit !== undefined && q.midPriceLamportsPerUnit > 0) {
      const atMid = BigInt(Math.floor(Number(args.tokenAmount) * q.midPriceLamportsPerUnit));
      this.costs.priceImpactLamports += nonNeg(atMid - atQuote);
    }
    this.bookOverhead(m);
    return { ok: true, lamportsReceived: fill.lamportsReceived, signature: null };
  }
}
