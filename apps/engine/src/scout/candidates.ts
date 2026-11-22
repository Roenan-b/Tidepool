import { z } from 'zod';
import type { Candidate, TradingMode } from '@tidepool/core';
import type { CandidateSource } from '../contracts.js';
import type { Queryable } from './types.js';
import { pgSafeString, toPgJson } from './util.js';

/*
 * Persistence for ranked candidates (`candidates` table, one row per mint). The Scout upserts every
 * cycle, including vetoed rows with their reason; `topCandidates` serves only unexpired, unvetoed
 * rows ordered by score. Rows read back are validated, and invalid rows are skipped (fail closed).
 */

const featuresSchema = z.object({
  liquidityUsd: z.number(),
  volume5mUsd: z.number(),
  volumeTrend: z.number(),
  priceChange5mPct: z.number(),
  holderCount: z.number(),
  holderGrowth15m: z.number(),
  mentionVelocity: z.number(),
  sentiment: z.number(),
  narrativeLabel: z.string().nullable(),
  narrativeScore: z.number().min(0).max(1).nullable(),
  boosted: z.boolean(),
});

const safetySchema = z.object({
  mint: z.string(),
  mintAuthorityRevoked: z.boolean(),
  freezeAuthorityRevoked: z.boolean(),
  token2022Extensions: z.array(z.string()),
  liquidityUsd: z.number(),
  top10HolderShare: z.number(),
  creatorFlagged: z.boolean(),
  ageSeconds: z.number(),
  sellSimulationRatio: z.number().nullable(),
});

const rowSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  pair_address: z.string(),
  score: z.number().min(0).max(100),
  price_usd: z.number(),
  features: featuresSchema,
  safety: safetySchema,
  reasons: z.array(z.string()),
  observed_at: z.date(),
  expires_at: z.date(),
});

export interface CandidateRow {
  candidate: Candidate;
  vetoReason: string | null;
}

export interface CandidateStore extends CandidateSource {
  upsertMany(rows: CandidateRow[]): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
  /** Active cooldowns for `mode` among `mints`, keyed by mint. */
  activeCooldowns(mode: TradingMode, mints: string[], now: Date): Promise<Map<string, Date>>;
}

function clampLimit(limit: number): number {
  return Math.max(0, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 0)));
}

export function rowToCandidate(row: unknown): Candidate | null {
  const r = rowSchema.safeParse(row);
  if (!r.success) return null;
  const d = r.data;
  return {
    mint: d.mint,
    symbol: d.symbol,
    pairAddress: d.pair_address,
    score: d.score,
    features: d.features,
    safety: d.safety,
    reasons: d.reasons,
    observedAt: d.observed_at.toISOString(),
    expiresAt: d.expires_at.toISOString(),
    priceUsd: d.price_usd,
  };
}

/** Read side used by the Trader and the control API. Never blocks on network or model calls. */
export class PgCandidateSource implements CandidateSource {
  constructor(protected readonly db: Queryable) {}

  async topCandidates(limit: number, now: Date): Promise<Candidate[]> {
    const n = clampLimit(limit);
    if (n === 0) return [];
    const { rows } = await this.db.query(
      `SELECT mint, symbol, pair_address, score, price_usd, features, safety, reasons, observed_at, expires_at
         FROM candidates
        WHERE expires_at > $1 AND veto_reason IS NULL
        ORDER BY score DESC, observed_at DESC, mint ASC
        LIMIT $2`,
      [now.toISOString(), n],
    );
    const out: Candidate[] = [];
    for (const row of rows) {
      const c = rowToCandidate(row);
      if (c) out.push(c);
    }
    return out;
  }
}

export class PgCandidateStore extends PgCandidateSource implements CandidateStore {
  async upsertMany(rows: CandidateRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      const params: unknown[] = [];
      const values: string[] = [];
      for (const { candidate: c, vetoReason } of chunk) {
        const b = params.length;
        // Text from token metadata must not be able to fail the whole batch (NUL or unpaired surrogates).
        params.push(
          pgSafeString(c.mint),
          pgSafeString(c.symbol),
          pgSafeString(c.pairAddress),
          c.score,
          c.priceUsd,
          toPgJson(c.features),
          toPgJson(c.safety),
          toPgJson(c.reasons),
          vetoReason === null ? null : pgSafeString(vetoReason),
          c.observedAt,
          c.expiresAt,
        );
        values.push(
          `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}::jsonb, $${b + 7}::jsonb, $${b + 8}::jsonb, $${b + 9}, $${b + 10}::timestamptz, $${b + 11}::timestamptz)`,
        );
      }
      await this.db.query(
        `INSERT INTO candidates (mint, symbol, pair_address, score, price_usd, features, safety, reasons, veto_reason, observed_at, expires_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (mint) DO UPDATE SET symbol = EXCLUDED.symbol, pair_address = EXCLUDED.pair_address, score = EXCLUDED.score,
           price_usd = EXCLUDED.price_usd, features = EXCLUDED.features, safety = EXCLUDED.safety, reasons = EXCLUDED.reasons,
           veto_reason = EXCLUDED.veto_reason, observed_at = EXCLUDED.observed_at, expires_at = EXCLUDED.expires_at`,
        params,
      );
    }
  }

  async deleteExpired(now: Date): Promise<number> {
    const r = await this.db.query(`DELETE FROM candidates WHERE expires_at <= $1`, [now.toISOString()]);
    return r.rowCount ?? 0;
  }

  async activeCooldowns(mode: TradingMode, mints: string[], now: Date): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (mints.length === 0) return out;
    const { rows } = await this.db.query<{ mint: string; until: Date }>(
      `SELECT mint, until FROM cooldowns WHERE mode = $1 AND mint = ANY($2::text[]) AND until > $3`,
      [mode, mints, now.toISOString()],
    );
    for (const r of rows) out.set(r.mint, new Date(r.until));
    return out;
  }
}

/** Same semantics as PgCandidateStore, held in memory (tests and backtests). */
export class InMemoryCandidateStore implements CandidateStore {
  readonly rows = new Map<string, CandidateRow>();
  readonly cooldowns = new Map<string, { mode: TradingMode; until: Date }>();

  async upsertMany(rows: CandidateRow[]): Promise<void> {
    for (const r of rows) this.rows.set(r.candidate.mint, structuredClone(r));
  }

  async deleteExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [mint, r] of this.rows) {
      if (Date.parse(r.candidate.expiresAt) <= now.getTime()) {
        this.rows.delete(mint);
        n++;
      }
    }
    return n;
  }

  async activeCooldowns(mode: TradingMode, mints: string[], now: Date): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    for (const m of mints) {
      const c = this.cooldowns.get(m);
      if (c && c.mode === mode && c.until.getTime() > now.getTime()) out.set(m, c.until);
    }
    return out;
  }

  async topCandidates(limit: number, now: Date): Promise<Candidate[]> {
    const n = clampLimit(limit);
    return [...this.rows.values()]
      .filter((r) => r.vetoReason === null && Date.parse(r.candidate.expiresAt) > now.getTime())
      .map((r) => r.candidate)
      .sort(
        (a, b) =>
          b.score - a.score || Date.parse(b.observedAt) - Date.parse(a.observedAt) || (a.mint < b.mint ? -1 : 1),
      )
      .slice(0, n)
      .map((c) => structuredClone(c));
  }
}
