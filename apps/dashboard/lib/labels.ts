/** Plain-language labels shared by both views. Client safe (type-only imports). */
import type { EngineState, HaltReason, PresetName, TradingMode } from '@tidepool/core';

export const HALT_REASON_TEXT: Record<HaltReason, string> = {
  daily_loss_limit:
    "Today's losses reached the daily loss limit. New trades stay off until tomorrow (UTC) unless Roe reviews and clears it.",
  drawdown_limit: 'The pool fell too far below its best value. Trading stays off until Roe and Jake review it.',
  reconciliation_mismatch:
    "The bot's books did not match the wallet balance on chain. Trading stopped so nothing is double counted.",
  landing_rate_collapse: 'Too many trades failed to land on the network, so the bot stopped to avoid wasting fees.',
  rpc_errors: 'The connection to the Solana network kept failing, so the bot stopped trading.',
  stale_data: 'Market data stopped updating, so the bot stopped rather than trade on old prices.',
  kill_switch: 'Someone pressed "Stop and sell everything". Open positions are being sold.',
  manual: 'An operator stopped trading by hand.',
};

export function haltText(reason: HaltReason | null): string {
  if (!reason) return 'Trading is halted.';
  return HALT_REASON_TEXT[reason] ?? 'Trading is halted.';
}

export const STATE_TEXT: Record<EngineState, string> = {
  stopped: 'Stopped',
  running: 'Running',
  paused: 'Paused',
  halted: 'Halted',
};

export const MODE_TEXT: Record<TradingMode, string> = { paper: 'PAPER', live: 'LIVE' };

export interface PresetSummary {
  name: PresetName;
  label: string;
  description: string;
  maxPositionPct: number;
  maxOpenPositions: number;
  dailyLossLimitPct: number;
}

/** Shape of GET /signals items. Not yet part of packages/core/src/api.ts (see report). */
export interface SignalDto {
  id: string;
  source: string;
  mint: string | null;
  kind: string;
  observedAt: string;
  payload: Record<string, unknown>;
}

export interface ApiError {
  error: string;
  message: string;
}
