/**
 * Types shared inside the trader module (and by the backtest harness, which drives the same Trader).
 * Cross-module contracts live in ../contracts.ts; nothing here is required by other engine modules.
 */
import type { CostModel, TradingMode } from '@tidepool/core';

/** Token venue, used to pick the cost model (core COST_MODELS keys). */
export type Venue = 'bondingCurve' | 'graduated';

export interface QuoteResult {
  /** Lamports per raw token unit for this size, after price impact as quoted by the venue. */
  priceLamportsPerUnit: number;
  /** Price impact of this size in percent (1.5 means 1.5%). */
  priceImpactPct: number;
  routeOk: boolean;
  /** Mid price before impact, when the source knows it (fixtures do; live routers usually do not). */
  midPriceLamportsPerUnit?: number;
  /** Venue the route goes through, when the source can tell. */
  venue?: Venue;
}

/**
 * Market quote provider used by the PaperBroker. Production wires a Jupiter-backed source,
 * tests and the backtest wire fixtures.
 * For side 'buy', `amount` is lamports in; for side 'sell', `amount` is raw token units in.
 */
export interface QuoteSource {
  quote(mint: string, side: 'buy' | 'sell', amount: bigint): Promise<QuoteResult>;
}

/** Minimal structured logger (pino compatible). */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface TraderAlert {
  level: 'warning' | 'critical';
  code:
    | 'exit_failed'
    | 'position_unquotable'
    | 'buy_outcome_unknown'
    | 'sell_outcome_unknown'
    | 'record_failed'
    | 'spend_above_reservation'
    | 'buy_no_tokens'
    | 'kill_switch';
  message: string;
  mint?: string;
  positionId?: string;
}

/**
 * Optional broker capability: SOL a live buy can move out of the wallet beyond the swap input, the tip and the
 * base fee (priority fee paid alongside a separate tip, rent for a new token account). The Trader subtracts it
 * from the reservation so that actual spend stays inside the approved amount.
 */
export interface BuyOverheadAware {
  extraBuyOverheadLamports(): bigint;
}

export function extraBuyOverheadOf(broker: object): bigint {
  const fn = (broker as Partial<BuyOverheadAware>).extraBuyOverheadLamports;
  if (typeof fn !== 'function') return 0n;
  const v = fn.call(broker);
  return typeof v === 'bigint' && v > 0n ? v : 0n;
}

export type AlertSink = (a: TraderAlert) => void | Promise<void>;

export type CostModelSelector = (mint: string) => CostModel;

export type OrderStatus = 'built' | 'submitted' | 'landed' | 'failed';

export interface NewOrder {
  id: string;
  mode: TradingMode;
  side: 'buy' | 'sell';
  mint: string;
  reservationId: string | null;
  positionId: string | null;
  /** When the signal that led to this order was observed (candidate.observedAt). */
  signalAt: Date | null;
  /** Strategy and config version that produced the order. Not persisted until the schema has a column for it. */
  configVersion: string;
  /** Lamports intended (buy: notional in; sell: null). */
  lamports: bigint | null;
  /** Token amount intended (sell), null for buys. */
  tokenAmount: bigint | null;
}

export interface OrderRepository {
  create(o: NewOrder): Promise<void>;
  markSubmitted(id: string, at: Date): Promise<void>;
  markLanded(
    id: string,
    r: { at: Date; signature: string | null; lamports: bigint; tokenAmount: bigint | null; feeLamports: bigint },
  ): Promise<void>;
  markFailed(id: string, r: { at: Date; error: string; feeLamports: bigint; signature?: string | null }): Promise<void>;
  attachPosition(id: string, positionId: string): Promise<void>;
}

/** Truncates and normalizes an error for storage and logs. Never includes request headers or secrets. */
export function errorText(err: unknown, max = 500): string {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : JSON.stringify(err);
  return (s ?? 'unknown error').slice(0, max);
}
