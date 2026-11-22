/**
 * Internal contracts between engine modules. Implementations live in:
 *   risk/     RiskOfficer (sole ledger writer), AuditLog
 *   scout/    Scout, collectors, filters, scoring, narrative classifier
 *   trader/   Trader, strategy, brokers (paper and live)
 *   api/      control API for the dashboard
 * Modules depend on these interfaces, never on each other's internals.
 */
import type { Candidate, HaltReason, PresetName, TokenSafety, TradingMode } from '@tidepool/core';
import type { SignedTicket } from '@tidepool/core/ticket';

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };

export interface AuditLog {
  append(e: { actor: 'scout' | 'trader' | 'risk' | 'signer' | 'operator' | 'owner' | 'system'; type: string; ref?: string | null; payload: Record<string, unknown> }): Promise<{ seq: number; hash: string }>;
  /** Recomputes the hash chain; returns the first broken seq or null if intact. */
  verify(fromSeq?: number): Promise<{ ok: boolean; brokenAt: number | null; checked: number }>;
}

export interface ReservationRequest {
  idempotencyKey: string;
  sleeve: string;              // strategy name
  mint: string;
  lamports: bigint;            // notional SOL to commit, including expected fees and tip
  candidate: Candidate;        // re-checked by the Risk Officer
  /** Expected price impact of this size vs liquidity, 0..1. */
  positionShareOfLiquidity: number;
}

export type ReservationDecision =
  | { approved: true; reservationId: string; lamports: bigint; ticket: SignedTicket | null; expiresAt: Date }
  | { approved: false; reason: string };

export interface FillReport {
  reservationId: string;
  orderId: string;
  mint: string;
  symbol: string;
  strategy: string;
  lamportsSpent: bigint;       // actual SOL out, including fees and tip
  tokenAmount: bigint;
  entryPriceUsd: number;
  signature: string | null;    // null in paper mode
}

export interface ExitReport {
  positionId: string;
  orderId: string;
  lamportsReceived: bigint;    // net SOL in after fees and tip
  reason: 'take_profit' | 'stop_loss' | 'time_stop' | 'kill_switch' | 'manual' | 'filter_change';
  signature: string | null;
}

export interface OpenPositionView {
  id: string; mint: string; symbol: string; strategy: string;
  /** 'closing' means the kill switch (or an operator) marked it for immediate sale. */
  status: 'open' | 'closing';
  entryLamports: bigint; tokenAmount: bigint; entryPriceUsd: number; openedAt: Date;
  markLamports: bigint | null;
}

export interface RiskOfficer {
  /** Atomically checks all limits and locks the amount. Never over-allocates under concurrency. */
  reserve(req: ReservationRequest): Promise<ReservationDecision>;
  /** Converts a held reservation into an open position; releases any unspent remainder. */
  recordFill(fill: FillReport): Promise<{ positionId: string }>;
  /** Releases a reservation after a failed or timed-out transaction. Fees burned on failure are booked. */
  release(reservationId: string, reason: string, burnedFeeLamports?: bigint): Promise<void>;
  /** Requests permission to sell; returns a ticket in live mode. Exits are never blocked by halts. */
  authorizeExit(positionId: string, reason: ExitReport['reason']): Promise<{ ticket: SignedTicket | null }>;
  recordExit(exit: ExitReport): Promise<{ realizedPnlLamports: bigint }>;
  /** Books fees burned by a failed sell; the position stays open (or closing) for a retry. */
  recordExitFailure(positionId: string, burnedFeeLamports: bigint, error: string): Promise<void>;
  /** Updates mark-to-market and enforces daily loss and drawdown limits. */
  markPositions(marks: Array<{ positionId: string; markLamports: bigint }>): Promise<void>;
  openPositions(): Promise<OpenPositionView[]>;
  halt(reason: HaltReason, detail: string): Promise<void>;
  canOpenNewPositions(): Promise<{ ok: boolean; reason: string | null }>;
  mode(): TradingMode;
}

/** Execution venue: PaperBroker simulates fills from live quotes plus the cost model; LiveBroker uses Jupiter and the signer. */
export interface Broker {
  readonly mode: TradingMode;
  /** Quote in lamports per raw token unit for buying/selling `amount`. */
  quote(mint: string, side: 'buy' | 'sell', amount: bigint): Promise<{ priceLamportsPerUnit: number; priceImpactPct: number; routeOk: boolean }>;
  buy(args: { mint: string; lamportsIn: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<{ ok: true; lamportsSpent: bigint; tokenAmount: bigint; signature: string | null } | { ok: false; error: string; burnedFeeLamports: bigint }>;
  sell(args: { mint: string; tokenAmount: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<{ ok: true; lamportsReceived: bigint; signature: string | null } | { ok: false; error: string; burnedFeeLamports: bigint }>;
}

export interface CandidateSource {
  /** Ranked, unexpired candidates. Read from cache; never blocks on network or model calls. */
  topCandidates(limit: number, now: Date): Promise<Candidate[]>;
}

export interface SafetyChecker {
  /** Re-fetches token safety facts (authorities, extensions, sell simulation). */
  check(mint: string, sizeLamports: bigint): Promise<TokenSafety>;
}

export interface EngineControl {
  start(preset: PresetName): Promise<void>;
  pause(): Promise<void>;
  killSwitch(): Promise<{ positionsClosing: number }>;
}
