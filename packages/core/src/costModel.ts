import { bpsOf } from './money.js';

/**
 * Round-trip cost model used by paper trading and the backtest. Defaults mirror design doc section 6;
 * replace them with measured values once paper and micro-live data exist.
 */
export interface CostModel {
  venueFeeBps: number; // per side
  slippageBps: number; // expected adverse fill vs quote, per side
  tipLamports: bigint; // per transaction
  baseFeeLamportsPerSig: bigint; // 5,000 lamports per signature on Solana
  signaturesPerTx: number;
  /** Probability (0..1) a transaction fails to land; failed transactions still pay base fee and tip. */
  failureRate: number;
}

export const COST_MODELS = {
  bondingCurve: {
    venueFeeBps: 125,
    slippageBps: 100,
    tipLamports: 1_000_000n,
    baseFeeLamportsPerSig: 5_000n,
    signaturesPerTx: 1,
    failureRate: 0.1,
  },
  graduated: {
    venueFeeBps: 30,
    slippageBps: 100,
    tipLamports: 1_000_000n,
    baseFeeLamportsPerSig: 5_000n,
    signaturesPerTx: 1,
    failureRate: 0.05,
  },
} satisfies Record<string, CostModel>;

export function txOverheadLamports(m: CostModel): bigint {
  return m.tipLamports + m.baseFeeLamportsPerSig * BigInt(m.signaturesPerTx);
}

export interface BuyFill {
  lamportsSpent: bigint; // total SOL leaving the wallet, including fees and tip
  tokenAmount: bigint; // raw units received
  effectivePrice: number; // lamports per raw token unit
}

/**
 * Simulates a buy of `lamportsIn` (notional, before fees) at `quotePriceLamportsPerUnit`.
 * Venue fee and slippage reduce tokens received; tip and base fee add to SOL spent.
 */
export function simulateBuy(lamportsIn: bigint, quotePriceLamportsPerUnit: number, m: CostModel): BuyFill {
  if (lamportsIn <= 0n) throw new RangeError('lamportsIn must be positive');
  if (!(quotePriceLamportsPerUnit > 0)) throw new RangeError('quote price must be positive');
  const afterFee = lamportsIn - bpsOf(lamportsIn, m.venueFeeBps);
  const fillPrice = quotePriceLamportsPerUnit * (1 + m.slippageBps / 10_000);
  const tokenAmount = BigInt(Math.floor(Number(afterFee) / fillPrice));
  return { lamportsSpent: lamportsIn + txOverheadLamports(m), tokenAmount, effectivePrice: fillPrice };
}

export interface SellFill {
  lamportsReceived: bigint; // net SOL back into the wallet after fees and tip (may be negative if dust)
  effectivePrice: number;
}

export function simulateSell(tokenAmount: bigint, quotePriceLamportsPerUnit: number, m: CostModel): SellFill {
  if (tokenAmount <= 0n) throw new RangeError('tokenAmount must be positive');
  if (!(quotePriceLamportsPerUnit >= 0)) throw new RangeError('quote price must be non-negative');
  const fillPrice = quotePriceLamportsPerUnit * (1 - m.slippageBps / 10_000);
  const gross = BigInt(Math.floor(Number(tokenAmount) * fillPrice));
  const afterFee = gross - bpsOf(gross, m.venueFeeBps);
  return { lamportsReceived: afterFee - txOverheadLamports(m), effectivePrice: fillPrice };
}

/** Expected round-trip cost as a fraction of position size, excluding failures. */
export function roundTripCostFraction(positionLamports: bigint, m: CostModel): number {
  const venue = (2 * m.venueFeeBps) / 10_000;
  const slip = (2 * m.slippageBps) / 10_000;
  const overhead = Number(2n * txOverheadLamports(m)) / Number(positionLamports);
  return venue + slip + overhead;
}
