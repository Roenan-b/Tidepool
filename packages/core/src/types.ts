export type TradingMode = 'paper' | 'live';
export type PresetName = 'conservative' | 'balanced' | 'aggressive';
export type EngineState = 'stopped' | 'running' | 'paused' | 'halted';

/** Why the Risk Officer halted trading. Halts block new entries until cleared by an operator. */
export type HaltReason =
  | 'daily_loss_limit'
  | 'drawdown_limit'
  | 'reconciliation_mismatch'
  | 'landing_rate_collapse'
  | 'rpc_errors'
  | 'stale_data'
  | 'kill_switch'
  | 'manual';

/** Token safety facts gathered by the Scout and re-checked by the Risk Officer before approval. */
export interface TokenSafety {
  mint: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  /** Token-2022 extensions present on the mint, e.g. 'transferFeeConfig', 'transferHook', 'permanentDelegate'. */
  token2022Extensions: string[];
  liquidityUsd: number;
  /** Share of supply (0..1) held by the top 10 holders, excluding the liquidity pool. */
  top10HolderShare: number;
  /** Creator wallet linked to previous rugs according to the local blocklist. */
  creatorFlagged: boolean;
  /** Token age in seconds at observation time. */
  ageSeconds: number;
  /** Ratio of simulated sell proceeds to the expected value for the same size (1 = no loss beyond fees). */
  sellSimulationRatio: number | null;
}

export interface CandidateFeatures {
  liquidityUsd: number;
  volume5mUsd: number;
  volumeTrend: number;        // ratio of last 5m volume to the prior 30m average per 5m
  priceChange5mPct: number;
  holderCount: number;
  holderGrowth15m: number;    // ratio
  mentionVelocity: number;    // quality-weighted mentions per minute, decayed
  sentiment: number;          // -1..1, quality-weighted
  narrativeLabel: string | null;
  narrativeScore: number | null; // 0..1 from the asynchronous classifier, null if not scored yet
  boosted: boolean;           // paid DEX Screener promotion
}

export interface Candidate {
  mint: string;
  symbol: string;
  pairAddress: string;
  score: number;              // 0..100
  features: CandidateFeatures;
  safety: TokenSafety;
  reasons: string[];
  observedAt: string;         // ISO time
  expiresAt: string;          // ISO time
  priceUsd: number;
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  strategy: string;
  mode: TradingMode;
  status: 'open' | 'closing' | 'closed';
  entryLamports: bigint;       // SOL spent including fees
  tokenAmount: bigint;         // raw token units
  entryPriceUsd: number;
  openedAt: string;
  closedAt: string | null;
  exitLamports: bigint | null; // SOL received after fees
  exitReason: string | null;
  realizedPnlLamports: bigint | null;
}

export type ReservationStatus = 'held' | 'filled' | 'released' | 'expired';

export interface Reservation {
  id: string;
  idempotencyKey: string;
  sleeve: string;
  mint: string;
  lamports: bigint;
  status: ReservationStatus;
  createdAt: string;
  expiresAt: string;
}

export interface RiskLimits {
  /** Max lamports per position, as basis points of pool equity. */
  maxPositionBps: number;
  maxOpenPositions: number;
  /** Max total exposure to one mint, as bps of pool equity. */
  maxPerTokenBps: number;
  /** Daily loss limit as bps of start-of-day equity. Hitting it halts new entries for the UTC day. */
  dailyLossLimitBps: number;
  /** Drawdown from peak equity, in bps, that halts fully until an operator clears it. */
  maxDrawdownBps: number;
  /** Lamports that can never be allocated, so the wallet can always pay exit fees. */
  feeReserveLamports: bigint;
}

export interface TokenFilterThresholds {
  minLiquidityUsd: number;
  maxTop10HolderShare: number;
  minAgeSeconds: number;
  maxAgeSeconds: number;
  minSellSimulationRatio: number;
  bannedToken2022Extensions: string[];
  /** Max position size as a share (0..1) of the token's liquidity. */
  maxPositionShareOfLiquidity: number;
  cooldownAfterStopSeconds: number;
}

export interface StrategyParams {
  name: string;
  minScore: number;
  takeProfitPct: number;
  stopLossPct: number;
  timeStopSeconds: number;
  /** Max slippage the Trader will accept on a swap quote, bps. */
  slippageBps: number;
  /** Priority fee or tip per transaction in lamports. */
  tipLamports: bigint;
}

export interface Preset {
  name: PresetName;
  label: string;
  description: string;
  limits: RiskLimits;
  filters: TokenFilterThresholds;
  strategy: StrategyParams;
}

/** Append-only audit event, hash-chained. */
export interface AuditEvent {
  seq: number;
  at: string;
  actor: 'scout' | 'trader' | 'risk' | 'signer' | 'operator' | 'owner' | 'system';
  type: string;
  ref: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}
