import type { Preset, PresetName } from './types.js';

/**
 * Pre-tested parameter bundles Jake picks from. Jake never edits raw values.
 * All numbers are starting points (see design doc sections 5 and 6) to be tuned with paper-trading data.
 */
const commonFilters = {
  bannedToken2022Extensions: [
    'transferFeeConfig',
    'transferHook',
    'permanentDelegate',
    'nonTransferable',
    'defaultAccountState',
  ],
  minSellSimulationRatio: 0.9,
};

export const PRESETS: Record<PresetName, Preset> = {
  conservative: {
    name: 'conservative',
    label: 'Conservative',
    description: 'Small positions, graduated tokens with deep liquidity, tight daily loss limit.',
    limits: {
      maxPositionBps: 300, // 3% of pool per position
      maxOpenPositions: 3,
      maxPerTokenBps: 300,
      dailyLossLimitBps: 300, // 3% of start-of-day equity
      maxDrawdownBps: 1500, // 15% from peak
      feeReserveLamports: 100_000_000n, // 0.1 SOL
    },
    filters: {
      ...commonFilters,
      minLiquidityUsd: 50_000,
      maxTop10HolderShare: 0.3,
      minAgeSeconds: 6 * 3600,
      maxAgeSeconds: 30 * 86400,
      maxPositionShareOfLiquidity: 0.005,
      cooldownAfterStopSeconds: 3600,
    },
    strategy: {
      name: 'momentum-v1',
      minScore: 75,
      takeProfitPct: 15,
      stopLossPct: 7,
      timeStopSeconds: 30 * 60,
      slippageBps: 100,
      tipLamports: 200_000n,
    },
  },
  balanced: {
    name: 'balanced',
    label: 'Balanced',
    description: 'Moderate positions on tokens with solid liquidity; default preset.',
    limits: {
      maxPositionBps: 500,
      maxOpenPositions: 5,
      maxPerTokenBps: 500,
      dailyLossLimitBps: 400,
      maxDrawdownBps: 2000,
      feeReserveLamports: 100_000_000n,
    },
    filters: {
      ...commonFilters,
      minLiquidityUsd: 20_000,
      maxTop10HolderShare: 0.4,
      minAgeSeconds: 1800,
      maxAgeSeconds: 14 * 86400,
      maxPositionShareOfLiquidity: 0.01,
      cooldownAfterStopSeconds: 1800,
    },
    strategy: {
      name: 'momentum-v1',
      minScore: 70,
      takeProfitPct: 14,
      stopLossPct: 8,
      timeStopSeconds: 20 * 60,
      slippageBps: 150,
      tipLamports: 500_000n,
    },
  },
  aggressive: {
    name: 'aggressive',
    label: 'Aggressive',
    description: 'Larger positions and younger tokens; higher loss limit. Use only after paper results justify it.',
    limits: {
      maxPositionBps: 800,
      maxOpenPositions: 6,
      maxPerTokenBps: 800,
      dailyLossLimitBps: 500,
      maxDrawdownBps: 2500,
      feeReserveLamports: 100_000_000n,
    },
    filters: {
      ...commonFilters,
      minLiquidityUsd: 15_000,
      maxTop10HolderShare: 0.5,
      minAgeSeconds: 600,
      maxAgeSeconds: 7 * 86400,
      maxPositionShareOfLiquidity: 0.015,
      cooldownAfterStopSeconds: 900,
    },
    strategy: {
      name: 'momentum-v1',
      minScore: 65,
      takeProfitPct: 15,
      stopLossPct: 9,
      timeStopSeconds: 15 * 60,
      slippageBps: 200,
      tipLamports: 1_000_000n,
    },
  },
};

export function getPreset(name: PresetName): Preset {
  const p = PRESETS[name];
  if (!p) throw new Error(`unknown preset: ${name}`);
  return p;
}
