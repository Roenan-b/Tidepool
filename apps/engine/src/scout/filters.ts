import type { TokenFilterThresholds, TokenSafety } from '@tidepool/core';

/*
 * Pure pre-trade token filters (design doc section 5). The Risk Officer re-checks with the same
 * functions, so semantics here are shared: a value exactly at a threshold passes, anything past it
 * is rejected, and any non-finite input is rejected (fail closed).
 */

export interface FilterResult {
  pass: boolean;
  reasons: string[];
}

export interface EvaluateSafetyOptions {
  /**
   * When true, a null sell simulation ratio is accepted. The Scout uses this for its cheap
   * ranking pass; the Risk Officer must leave it false so a missing simulation rejects.
   */
  allowMissingSellSimulation?: boolean;
}

export const FilterReasons = {
  mintAuthority: 'mint_authority_not_revoked',
  freezeAuthority: 'freeze_authority_not_revoked',
  bannedExtension: 'banned_token2022_extension',
  unvettedExtension: 'unvetted_token2022_extension',
  liquidity: 'liquidity_below_min',
  concentration: 'top10_holder_share_above_max',
  creator: 'creator_flagged',
  tooNew: 'token_too_new',
  tooOld: 'token_too_old',
  sellSimMissing: 'sell_simulation_missing',
  sellSimLow: 'sell_simulation_below_min',
  invalid: 'invalid_safety_data',
  positionTooLarge: 'position_share_of_liquidity_above_max',
  cooldown: 'cooldown_active',
} as const;

/**
 * Token-2022 mint extensions known to be unable to tax, block, pause, seize or hide transfers or
 * supply. Every other extension, including ones added to the token program later and any the RPC
 * reports as unparseable, is rejected: a deny list alone fails open on extensions such as
 * `pausableConfig` (an authority can halt all transfers) or `confidentialMintBurn`.
 */
export const VETTED_TOKEN2022_EXTENSIONS: ReadonlySet<string> = new Set([
  'metadatapointer',
  'tokenmetadata',
  'grouppointer',
  'tokengroup',
  'groupmemberpointer',
  'tokengroupmember',
  'mintcloseauthority',
]);

function finite(...xs: number[]): boolean {
  return xs.every((x) => typeof x === 'number' && Number.isFinite(x));
}

export function evaluateSafety(safety: TokenSafety, filters: TokenFilterThresholds, opts: EvaluateSafetyOptions = {}): FilterResult {
  const reasons: string[] = [];
  if (!finite(safety.liquidityUsd, safety.top10HolderShare, safety.ageSeconds) || !Array.isArray(safety.token2022Extensions)) {
    return { pass: false, reasons: [FilterReasons.invalid] };
  }
  if (safety.mintAuthorityRevoked !== true) reasons.push(FilterReasons.mintAuthority);
  if (safety.freezeAuthorityRevoked !== true) reasons.push(FilterReasons.freezeAuthority);
  const banned = new Set(filters.bannedToken2022Extensions.map((x) => x.toLowerCase()));
  for (const raw of safety.token2022Extensions) {
    const ext = typeof raw === 'string' ? raw.slice(0, 64) : 'invalid';
    const key = ext.toLowerCase();
    if (banned.has(key)) reasons.push(`${FilterReasons.bannedExtension}:${ext}`);
    else if (!VETTED_TOKEN2022_EXTENSIONS.has(key)) reasons.push(`${FilterReasons.unvettedExtension}:${ext}`);
  }
  if (safety.liquidityUsd < filters.minLiquidityUsd) reasons.push(FilterReasons.liquidity);
  if (safety.top10HolderShare > filters.maxTop10HolderShare || safety.top10HolderShare < 0) reasons.push(FilterReasons.concentration);
  if (safety.creatorFlagged !== false) reasons.push(FilterReasons.creator);
  if (safety.ageSeconds < filters.minAgeSeconds) reasons.push(FilterReasons.tooNew);
  if (safety.ageSeconds > filters.maxAgeSeconds) reasons.push(FilterReasons.tooOld);
  if (safety.sellSimulationRatio === null) {
    if (!opts.allowMissingSellSimulation) reasons.push(FilterReasons.sellSimMissing);
  } else if (!finite(safety.sellSimulationRatio) || safety.sellSimulationRatio < filters.minSellSimulationRatio) {
    reasons.push(FilterReasons.sellSimLow);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Rejects a position whose USD size exceeds the allowed share of the token's liquidity. */
export function evaluatePositionShare(positionUsd: number, liquidityUsd: number, filters: TokenFilterThresholds): FilterResult {
  if (!finite(positionUsd, liquidityUsd) || positionUsd < 0 || liquidityUsd <= 0) {
    return { pass: false, reasons: [FilterReasons.invalid] };
  }
  const share = positionUsd / liquidityUsd;
  return share > filters.maxPositionShareOfLiquidity ? { pass: false, reasons: [FilterReasons.positionTooLarge] } : { pass: true, reasons: [] };
}

/** Rejects while a cooldown (for example after a stop-loss) is still running. */
export function evaluateCooldown(cooldownUntil: Date | null, now: Date): FilterResult {
  if (cooldownUntil && cooldownUntil.getTime() > now.getTime()) return { pass: false, reasons: [FilterReasons.cooldown] };
  return { pass: true, reasons: [] };
}
