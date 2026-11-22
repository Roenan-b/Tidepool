/**
 * Shared fixtures for Risk Officer and control API tests. Not used at runtime.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { PRESETS, type Candidate, type Preset, type PresetName, type TokenSafety } from '@tidepool/core';
import type { Clock, ReservationRequest } from '../contracts.js';

export class FakeClock implements Clock {
  private t: number;
  constructor(iso = '2026-11-22T10:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Random base58 string of 44 chars; shaped like a mint address (not necessarily on-curve). */
export function fakeMint(): string {
  const bytes = randomBytes(44);
  let s = '';
  for (const b of bytes) s += B58[b % 58];
  return s;
}

export const SOL = 1_000_000_000n;

/** A permissive preset; tests override the one limit they exercise. */
export function testPreset(
  over: {
    limits?: Partial<Preset['limits']>;
    filters?: Partial<Preset['filters']>;
    strategy?: Partial<Preset['strategy']>;
  } = {},
): Preset {
  const base = PRESETS.balanced;
  return {
    ...base,
    limits: {
      ...base.limits,
      maxPositionBps: 10_000,
      maxOpenPositions: 10_000,
      maxPerTokenBps: 10_000,
      dailyLossLimitBps: 10_000,
      maxDrawdownBps: 10_000,
      ...over.limits,
    },
    filters: { ...base.filters, ...over.filters },
    strategy: { ...base.strategy, ...over.strategy },
  };
}

/** Preset resolver whose 'balanced' entry can be swapped per test. */
export class PresetBox {
  current: Preset;
  constructor(p: Preset = testPreset()) {
    this.current = p;
  }
  resolver = (name: PresetName): Preset => (name === 'balanced' ? this.current : PRESETS[name]);
}

export function safeToken(mint: string, over: Partial<TokenSafety> = {}): TokenSafety {
  return {
    mint,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    token2022Extensions: [],
    liquidityUsd: 100_000,
    top10HolderShare: 0.2,
    creatorFlagged: false,
    ageSeconds: 3 * 3600,
    sellSimulationRatio: 0.98,
    ...over,
  };
}

export function candidate(
  mint: string,
  clock: Clock,
  over: { safety?: Partial<TokenSafety>; expiresInMs?: number; symbol?: string } = {},
): Candidate {
  const now = clock.now();
  return {
    mint,
    symbol: over.symbol ?? 'TEST',
    pairAddress: mint,
    score: 80,
    features: {
      liquidityUsd: 100_000,
      volume5mUsd: 10_000,
      volumeTrend: 1.5,
      priceChange5mPct: 3,
      holderCount: 900,
      holderGrowth15m: 1.1,
      mentionVelocity: 2,
      sentiment: 0.3,
      narrativeLabel: null,
      narrativeScore: null,
      boosted: false,
    },
    safety: safeToken(mint, over.safety),
    reasons: ['test'],
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (over.expiresInMs ?? 120_000)).toISOString(),
    priceUsd: 0.001,
  };
}

let seq = 0;
export function request(
  mint: string,
  lamports: bigint,
  clock: Clock,
  over: Partial<ReservationRequest> & { safety?: Partial<TokenSafety> } = {},
): ReservationRequest {
  const { safety, ...rest } = over;
  return {
    idempotencyKey: `k-${process.pid}-${++seq}-${randomBytes(4).toString('hex')}`,
    sleeve: 'momentum-v1',
    mint,
    lamports,
    candidate: candidate(mint, clock, safety ? { safety } : {}),
    positionShareOfLiquidity: 0.001,
    ...rest,
  };
}

/** Clears book tables and resets pool and settings rows (audit_events is append-only and kept). */
export async function resetBook(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE orders, positions, reservations, ledger_entries, cooldowns, reconciliation_runs');
  await pool.query(`DELETE FROM sleeves WHERE name <> 'momentum-v1'`);
  await pool.query(
    `UPDATE pool_state SET engine_state = 'stopped', halt_reason = NULL, preset = 'balanced', cash_lamports = 0,
            peak_equity_lamports = 0, sod_equity_lamports = 0, sod_date = NULL`,
  );
  await pool.query(
    `UPDATE settings SET active_mode = 'paper', deposit_address = NULL, withdraw_address = NULL,
            pending_withdraw_address = NULL, pending_withdraw_effective_at = NULL`,
  );
}

export async function ledgerSum(pool: pg.Pool, mode: 'paper' | 'live'): Promise<bigint> {
  const r = await pool.query<{ s: string }>(
    'SELECT coalesce(sum(lamports), 0)::text AS s FROM ledger_entries WHERE mode = $1',
    [mode],
  );
  return BigInt(r.rows[0]!.s);
}

export async function cashOf(pool: pg.Pool, mode: 'paper' | 'live'): Promise<bigint> {
  const r = await pool.query<{ c: string }>('SELECT cash_lamports::text AS c FROM pool_state WHERE mode = $1', [mode]);
  return BigInt(r.rows[0]!.c);
}

export async function stateOf(
  pool: pg.Pool,
  mode: 'paper' | 'live',
): Promise<{ state: string; reason: string | null }> {
  const r = await pool.query<{ engine_state: string; halt_reason: string | null }>(
    'SELECT engine_state, halt_reason FROM pool_state WHERE mode = $1',
    [mode],
  );
  return { state: r.rows[0]!.engine_state, reason: r.rows[0]!.halt_reason };
}
