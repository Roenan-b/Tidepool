import { describe, expect, it } from 'vitest';
import { PRESETS, type TokenSafety } from '@tidepool/core';
import { evaluateCooldown, evaluatePositionShare, evaluateSafety } from './filters.js';

const filters = PRESETS.balanced.filters;

function safe(o: Partial<TokenSafety> = {}): TokenSafety {
  return {
    mint: 'm',
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    token2022Extensions: [],
    liquidityUsd: filters.minLiquidityUsd,
    top10HolderShare: filters.maxTop10HolderShare,
    creatorFlagged: false,
    ageSeconds: filters.minAgeSeconds,
    sellSimulationRatio: filters.minSellSimulationRatio,
    ...o,
  };
}

describe('evaluateSafety', () => {
  it('passes when every value sits exactly on its threshold', () => {
    expect(evaluateSafety(safe(), filters)).toEqual({ pass: true, reasons: [] });
    expect(evaluateSafety(safe({ ageSeconds: filters.maxAgeSeconds }), filters).pass).toBe(true);
  });

  const cases: [string, Partial<TokenSafety>, string][] = [
    ['liquidity just below the floor', { liquidityUsd: filters.minLiquidityUsd - 0.01 }, 'liquidity_below_min'],
    [
      'holder share just above the cap',
      { top10HolderShare: filters.maxTop10HolderShare + 1e-9 },
      'top10_holder_share_above_max',
    ],
    ['age one second too young', { ageSeconds: filters.minAgeSeconds - 1 }, 'token_too_new'],
    ['age one second too old', { ageSeconds: filters.maxAgeSeconds + 1 }, 'token_too_old'],
    [
      'sell ratio just below the minimum',
      { sellSimulationRatio: filters.minSellSimulationRatio - 1e-9 },
      'sell_simulation_below_min',
    ],
    ['missing sell simulation', { sellSimulationRatio: null }, 'sell_simulation_missing'],
    ['mint authority present', { mintAuthorityRevoked: false }, 'mint_authority_not_revoked'],
    ['freeze authority present', { freezeAuthorityRevoked: false }, 'freeze_authority_not_revoked'],
    ['flagged creator', { creatorFlagged: true }, 'creator_flagged'],
    [
      'banned extension',
      { token2022Extensions: ['permanentDelegate'] },
      'banned_token2022_extension:permanentDelegate',
    ],
    ['NaN liquidity', { liquidityUsd: Number.NaN }, 'invalid_safety_data'],
    ['infinite sell ratio', { sellSimulationRatio: Number.POSITIVE_INFINITY }, 'sell_simulation_below_min'],
    ['negative holder share', { top10HolderShare: -0.1 }, 'top10_holder_share_above_max'],
  ];
  for (const [name, patch, reason] of cases) {
    it(`rejects ${name}`, () => {
      const r = evaluateSafety(safe(patch), filters);
      expect(r.pass).toBe(false);
      expect(r.reasons).toContain(reason);
    });
  }

  it('rejects extensions outside the vetted list and malformed extension data', () => {
    for (const ext of [
      'pausableConfig',
      'confidentialMintBurn',
      'scaledUiAmountConfig',
      'unparseableExtension',
      'someFutureExtension',
    ]) {
      const r = evaluateSafety(safe({ token2022Extensions: [ext] }), filters);
      expect(r.pass).toBe(false);
      expect(r.reasons).toEqual([`unvetted_token2022_extension:${ext}`]);
    }
    // Banned names match case-insensitively, as in the Risk Officer re-check.
    expect(evaluateSafety(safe({ token2022Extensions: ['TransferHook'] }), filters).reasons).toEqual([
      'banned_token2022_extension:TransferHook',
    ]);
    expect(evaluateSafety(safe({ token2022Extensions: undefined as unknown as string[] }), filters)).toEqual({
      pass: false,
      reasons: ['invalid_safety_data'],
    });
  });

  it('allows unbanned extensions and an optional missing simulation for the ranking pass', () => {
    expect(evaluateSafety(safe({ token2022Extensions: ['metadataPointer', 'tokenMetadata'] }), filters).pass).toBe(
      true,
    );
    expect(
      evaluateSafety(safe({ sellSimulationRatio: null }), filters, { allowMissingSellSimulation: true }).pass,
    ).toBe(true);
  });

  it('collects every failing reason', () => {
    const r = evaluateSafety(safe({ mintAuthorityRevoked: false, liquidityUsd: 0, creatorFlagged: true }), filters);
    expect(r.reasons).toHaveLength(3);
  });
});

describe('evaluatePositionShare and evaluateCooldown', () => {
  it('rejects only above the share boundary', () => {
    const liq = 100_000;
    expect(evaluatePositionShare(liq * filters.maxPositionShareOfLiquidity, liq, filters).pass).toBe(true);
    expect(evaluatePositionShare(liq * filters.maxPositionShareOfLiquidity + 0.01, liq, filters).pass).toBe(false);
    expect(evaluatePositionShare(10, 0, filters).reasons).toEqual(['invalid_safety_data']);
  });

  it('rejects while a cooldown runs and passes at its end', () => {
    const now = new Date('2026-11-22T12:00:00Z');
    expect(evaluateCooldown(new Date(now.getTime() + 1), now).pass).toBe(false);
    expect(evaluateCooldown(now, now).pass).toBe(true);
    expect(evaluateCooldown(null, now).pass).toBe(true);
  });
});
