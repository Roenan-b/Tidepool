import { z } from 'zod';
import type { EngineState, HaltReason, PresetName, TradingMode } from './types.js';

/**
 * Engine control API contract (engine listens on 127.0.0.1, dashboard server calls it with a bearer token).
 * All lamport amounts cross the wire as decimal strings.
 */
export type Lamports = string;

export interface StatusDto {
  mode: TradingMode;
  liveTradingAllowed: boolean; // LIVE_TRADING_ENABLED flag from engine config
  state: EngineState;
  haltReason: HaltReason | null;
  preset: PresetName;
  solUsd: number | null;
  pool: {
    equityLamports: Lamports; // cash + marked value of open positions
    cashLamports: Lamports; // unreserved, excluding fee reserve
    reservedLamports: Lamports;
    inPositionsLamports: Lamports; // marked to market
    feeReserveLamports: Lamports;
  };
  today: {
    date: string; // UTC YYYY-MM-DD
    netPnlLamports: Lamports; // realized + unrealized, after all fees
    lossLimitLamports: Lamports; // positive number; halt when netPnl <= -lossLimit
    trades: number;
    wins: number;
    stretchTargetUsd: number; // shown as a reference line only
  };
  wallet: {
    depositAddress: string | null;
    withdrawAddress: string | null;
    pendingWithdrawAddress: string | null;
    pendingWithdrawEffectiveAt: string | null;
  };
  updatedAt: string;
}

export interface PositionDto {
  id: string;
  mint: string;
  symbol: string;
  strategy: string;
  mode: TradingMode;
  status: 'open' | 'closing' | 'closed';
  entryLamports: Lamports;
  markLamports: Lamports | null;
  unrealizedPnlLamports: Lamports | null;
  realizedPnlLamports: Lamports | null;
  openedAt: string;
  closedAt: string | null;
  exitReason: string | null;
}

export interface CandidateDto {
  mint: string;
  symbol: string;
  score: number;
  reasons: string[];
  priceUsd: number;
  liquidityUsd: number;
  mentionVelocity: number;
  sentiment: number;
  narrativeLabel: string | null;
  observedAt: string;
  expiresAt: string;
  vetoReason: string | null;
}

export interface AuditEventDto {
  seq: number;
  at: string;
  actor: string;
  type: string;
  ref: string | null;
  payload: Record<string, unknown>;
  hash: string;
}

export interface MetricsDto {
  latencyMs: { signalToSubmit: { p50: number | null; p95: number | null; p99: number | null } };
  landingRate: number | null; // landed / submitted over the last hour
  rpc: { healthy: boolean; lastOkAt: string | null; errorRate: number };
  dataFreshnessSeconds: Record<string, number | null>; // per collector
  reconciliation: { lastRunAt: string | null; ok: boolean | null; diffLamports: Lamports | null };
  auditChainValid: boolean | null;
  tradesLast24h: number;
}

export const StartRequest = z.object({ preset: z.enum(['conservative', 'balanced', 'aggressive']) });
export const KillRequest = z.object({ confirm: z.literal('SELL_ALL') });
export const ModeRequest = z.object({ mode: z.enum(['paper', 'live']), confirm: z.string().optional() });
/** Solana base58 public key: 32-44 chars from the base58 alphabet. Full decoding is done server-side. */
export const Base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const WithdrawAddressRequest = z.object({ address: Base58Address });
export const WithdrawRequest = z.object({ lamports: z.string().regex(/^\d+$/) });
export const ClearHaltRequest = z.object({ reason: z.string().min(3).max(500) });

export const LIVE_MODE_CONFIRMATION = 'I understand real money will be traded';

/** Row of the raw signal feed (GET /signals). */
export interface SignalDto {
  id: string;
  source: string;
  mint: string | null;
  kind: string;
  observedAt: string;
  payload: Record<string, unknown>;
}
