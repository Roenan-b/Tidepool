import type { Candidate, TokenFilterThresholds } from '@tidepool/core';
// Pure constant from a dependency-free module (type-only imports), shared so the Scout and the
// Risk Officer vet extensions identically.
import { VETTED_TOKEN2022_EXTENSIONS } from '../scout/filters.js';

/**
 * Re-checks a candidate's token safety facts against the active preset's filters.
 * Returns the first veto reason, or null when every filter passes. Missing or malformed data
 * fails closed.
 */
export function tokenSafetyVeto(candidate: Candidate, f: TokenFilterThresholds, now: Date): string | null {
  const s = candidate.safety;
  if (!s || typeof s !== 'object' || s.mint !== candidate.mint) return 'safety:mismatched_mint';
  if (s.mintAuthorityRevoked !== true) return 'safety:mint_authority';
  if (s.freezeAuthorityRevoked !== true) return 'safety:freeze_authority';
  if (!Array.isArray(s.token2022Extensions)) return 'safety:token2022_unknown';
  const banned = new Set(f.bannedToken2022Extensions.map((x) => x.toLowerCase()));
  for (const ext of s.token2022Extensions) {
    if (typeof ext !== 'string' || banned.has(ext.toLowerCase()))
      return `safety:token2022_extension:${String(ext).slice(0, 64)}`;
    // Allowlist: anything not vetted (pausableConfig, confidentialMintBurn, unparseable or future extensions) fails closed.
    if (!VETTED_TOKEN2022_EXTENSIONS.has(ext.toLowerCase()))
      return `safety:unvetted_token2022_extension:${ext.slice(0, 64)}`;
  }
  if (!Number.isFinite(s.liquidityUsd) || s.liquidityUsd < f.minLiquidityUsd) return 'safety:min_liquidity';
  if (!Number.isFinite(s.top10HolderShare) || s.top10HolderShare < 0 || s.top10HolderShare > f.maxTop10HolderShare)
    return 'safety:top10_concentration';
  const observedMs = Date.parse(candidate.observedAt);
  if (!Number.isFinite(s.ageSeconds) || !Number.isFinite(observedMs)) return 'safety:age_unknown';
  const ageNow = s.ageSeconds + Math.max(0, (now.getTime() - observedMs) / 1000);
  if (ageNow < f.minAgeSeconds) return 'safety:too_new';
  if (ageNow > f.maxAgeSeconds) return 'safety:too_old';
  if (s.sellSimulationRatio === null || s.sellSimulationRatio === undefined) return 'safety:sell_simulation_missing';
  if (!Number.isFinite(s.sellSimulationRatio) || s.sellSimulationRatio < f.minSellSimulationRatio)
    return 'safety:sell_simulation';
  if (s.creatorFlagged !== false) return 'safety:creator_flagged';
  return null;
}
