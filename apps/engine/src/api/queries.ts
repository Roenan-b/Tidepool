import type pg from 'pg';
import {
  bpsOf,
  getPreset,
  type AuditEventDto,
  type CandidateDto,
  type HaltReason,
  type MetricsDto,
  type PositionDto,
  type Preset,
  type PresetName,
  type StatusDto,
  type TradingMode,
  type EngineState,
} from '@tidepool/core';
import type { Clock } from '../contracts.js';
import { systemClock } from '../contracts.js';
import type { PgAuditLog } from '../audit/pgAuditLog.js';
import { toBig, toBigOrNull } from '../db/pool.js';
import { loadBookTotals, utcDate } from '../risk/book.js';

export interface SignalDto {
  id: string;
  source: string;
  mint: string | null;
  kind: string;
  observedAt: string;
  payload: unknown;
}

/** Read model used by the control API. Implemented by PgQueries; tests may supply fakes. */
export interface ControlQueries {
  activeMode(): Promise<TradingMode>;
  status(): Promise<StatusDto>;
  positions(opts: { status: 'open' | 'closed' | 'all'; limit: number }): Promise<PositionDto[]>;
  candidates(limit: number): Promise<CandidateDto[]>;
  events(opts: { limit: number; before: number | null }): Promise<AuditEventDto[]>;
  metrics(): Promise<MetricsDto>;
  signals(limit: number, source?: string | null): Promise<SignalDto[]>;
}

export interface RpcHealth {
  healthy: boolean;
  lastOkAt: string | null;
  errorRate: number;
}

export interface PgQueriesOptions {
  pool: pg.Pool;
  audit: PgAuditLog;
  clock?: Clock;
  preset?: (name: PresetName) => Preset;
  solUsd?: () => number | null;
  liveTradingAllowed: boolean;
  stretchTargetUsd: number;
  /** Supplied by whoever owns the RPC client; reported as unhealthy until wired. */
  rpcHealth?: () => RpcHealth;
  /** Collector names always listed in dataFreshnessSeconds, even with no recent rows. */
  knownSignalSources?: string[];
  /** How long a full audit-chain verification result is reused. */
  auditVerifyTtlMs?: number;
}

const MAX_LIMIT = 500;
function clampLimit(n: number, def: number): number {
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIMIT);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return Math.round(sorted[idx]!);
}

/** Read-only queries over the engine database for the dashboard. Never writes ledger tables. */
export class PgQueries implements ControlQueries {
  private readonly pool: pg.Pool;
  private readonly audit: PgAuditLog;
  private readonly clock: Clock;
  private readonly presetFor: (name: PresetName) => Preset;
  private readonly solUsd: () => number | null;
  private readonly liveTradingAllowed: boolean;
  private readonly stretchTargetUsd: number;
  private readonly rpcHealth: () => RpcHealth;
  private readonly knownSources: string[];
  private readonly auditTtlMs: number;
  private auditCache: { at: number; ok: boolean } | null = null;
  private auditRefresh: Promise<boolean> | null = null;

  constructor(opts: PgQueriesOptions) {
    this.pool = opts.pool;
    this.audit = opts.audit;
    this.clock = opts.clock ?? systemClock;
    this.presetFor = opts.preset ?? getPreset;
    this.solUsd = opts.solUsd ?? (() => null);
    this.liveTradingAllowed = opts.liveTradingAllowed;
    this.stretchTargetUsd = opts.stretchTargetUsd;
    this.rpcHealth = opts.rpcHealth ?? (() => ({ healthy: false, lastOkAt: null, errorRate: 0 }));
    this.knownSources = opts.knownSignalSources ?? [];
    this.auditTtlMs = opts.auditVerifyTtlMs ?? 5 * 60_000;
  }

  async activeMode(): Promise<TradingMode> {
    const r = await this.pool.query<{ active_mode: TradingMode }>('SELECT active_mode FROM settings WHERE id = 1');
    return r.rows[0]?.active_mode ?? 'paper';
  }

  async status(): Promise<StatusDto> {
    const now = this.clock.now();
    const mode = await this.activeMode();
    const row = (
      await this.pool.query<{
        engine_state: EngineState;
        halt_reason: string | null;
        preset: PresetName;
        cash_lamports: string;
        sod_equity_lamports: string;
        sod_date: string | null;
      }>(
        `SELECT engine_state, halt_reason, preset, cash_lamports, sod_equity_lamports, to_char(sod_date, 'YYYY-MM-DD') AS sod_date FROM pool_state WHERE mode = $1`,
        [mode],
      )
    ).rows[0];
    if (!row) throw new Error('pool_state row missing');
    const settings = (
      await this.pool.query<{
        deposit_address: string | null;
        withdraw_address: string | null;
        pending_withdraw_address: string | null;
        pending_withdraw_effective_at: Date | null;
      }>(
        'SELECT deposit_address, withdraw_address, pending_withdraw_address, pending_withdraw_effective_at FROM settings WHERE id = 1',
      )
    ).rows[0];
    const book = await loadBookTotals(this.pool, mode);
    const preset = this.presetFor(row.preset);
    const cash = toBig(row.cash_lamports);
    const equity = cash + book.inPositionsLamports;
    const fee = preset.limits.feeReserveLamports;
    const free = cash - book.heldLamports - fee;
    const today = utcDate(now);
    const sod = row.sod_date === today ? toBig(row.sod_equity_lamports) : equity;
    const trades = (
      await this.pool.query<{ n: string; wins: string }>(
        `SELECT count(*)::text AS n, count(*) FILTER (WHERE realized_pnl_lamports > 0)::text AS wins
         FROM positions WHERE mode = $1 AND status = 'closed'
          AND closed_at >= (($2::date)::timestamp AT TIME ZONE 'UTC') AND closed_at < ((($2::date) + 1)::timestamp AT TIME ZONE 'UTC')`,
        [mode, today],
      )
    ).rows[0]!;
    return {
      mode,
      liveTradingAllowed: this.liveTradingAllowed,
      state: row.engine_state,
      haltReason: row.halt_reason as HaltReason | null,
      preset: row.preset,
      solUsd: this.solUsd(),
      pool: {
        equityLamports: equity.toString(),
        cashLamports: (free > 0n ? free : 0n).toString(),
        reservedLamports: book.heldLamports.toString(),
        inPositionsLamports: book.inPositionsLamports.toString(),
        feeReserveLamports: fee.toString(),
      },
      today: {
        date: today,
        netPnlLamports: (equity - sod).toString(),
        lossLimitLamports: bpsOf(sod, preset.limits.dailyLossLimitBps).toString(),
        trades: Number(trades.n),
        wins: Number(trades.wins),
        stretchTargetUsd: this.stretchTargetUsd,
      },
      wallet: {
        depositAddress: settings?.deposit_address ?? null,
        withdrawAddress: settings?.withdraw_address ?? null,
        pendingWithdrawAddress: settings?.pending_withdraw_address ?? null,
        pendingWithdrawEffectiveAt: settings?.pending_withdraw_effective_at?.toISOString() ?? null,
      },
      updatedAt: now.toISOString(),
    };
  }

  async positions(opts: { status: 'open' | 'closed' | 'all'; limit: number }): Promise<PositionDto[]> {
    const mode = await this.activeMode();
    const limit = clampLimit(opts.limit, 50);
    const where =
      opts.status === 'closed' ? `status = 'closed'` : opts.status === 'all' ? 'TRUE' : `status <> 'closed'`;
    const order = opts.status === 'closed' ? 'closed_at DESC' : 'opened_at DESC';
    const res = await this.pool.query<{
      id: string;
      mint: string;
      symbol: string;
      strategy: string;
      mode: TradingMode;
      status: PositionDto['status'];
      entry_lamports: string;
      mark_lamports: string | null;
      realized_pnl_lamports: string | null;
      opened_at: Date;
      closed_at: Date | null;
      exit_reason: string | null;
    }>(
      `SELECT id, mint, symbol, strategy, mode, status, entry_lamports, mark_lamports, realized_pnl_lamports, opened_at, closed_at, exit_reason
         FROM positions WHERE mode = $1 AND ${where} ORDER BY ${order} LIMIT $2`,
      [mode, limit],
    );
    return res.rows.map((r) => {
      const entry = toBig(r.entry_lamports);
      const mark = r.status === 'closed' ? null : toBigOrNull(r.mark_lamports);
      return {
        id: r.id,
        mint: r.mint,
        symbol: r.symbol,
        strategy: r.strategy,
        mode: r.mode,
        status: r.status,
        entryLamports: entry.toString(),
        markLamports: mark === null ? null : mark.toString(),
        unrealizedPnlLamports: mark === null ? null : (mark - entry).toString(),
        realizedPnlLamports: r.realized_pnl_lamports,
        openedAt: r.opened_at.toISOString(),
        closedAt: r.closed_at ? r.closed_at.toISOString() : null,
        exitReason: r.exit_reason,
      };
    });
  }

  async candidates(limit: number): Promise<CandidateDto[]> {
    const res = await this.pool.query<{
      mint: string;
      symbol: string;
      score: number;
      reasons: unknown;
      price_usd: number;
      features: Record<string, unknown>;
      safety: Record<string, unknown>;
      veto_reason: string | null;
      observed_at: Date;
      expires_at: Date;
    }>(
      `SELECT mint, symbol, score, reasons, price_usd, features, safety, veto_reason, observed_at, expires_at
         FROM candidates WHERE expires_at > $1 ORDER BY score DESC LIMIT $2`,
      [this.clock.now(), clampLimit(limit, 50)],
    );
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return res.rows.map((r) => ({
      mint: r.mint,
      symbol: r.symbol,
      score: r.score,
      reasons: Array.isArray(r.reasons) ? r.reasons.filter((x): x is string => typeof x === 'string').slice(0, 20) : [],
      priceUsd: r.price_usd,
      liquidityUsd: num(r.features?.liquidityUsd ?? r.safety?.liquidityUsd),
      mentionVelocity: num(r.features?.mentionVelocity),
      sentiment: num(r.features?.sentiment),
      narrativeLabel: typeof r.features?.narrativeLabel === 'string' ? r.features.narrativeLabel : null,
      observedAt: r.observed_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      vetoReason: r.veto_reason,
    }));
  }

  async events(opts: { limit: number; before: number | null }): Promise<AuditEventDto[]> {
    const rows = await this.audit.list({ limit: clampLimit(opts.limit, 100), before: opts.before });
    return rows.map((e) => ({
      seq: e.seq,
      at: e.at,
      actor: e.actor,
      type: e.type,
      ref: e.ref,
      payload: e.payload,
      hash: e.hash,
    }));
  }

  async signals(limit: number, source: string | null = null): Promise<SignalDto[]> {
    const res = await this.pool.query<{
      id: string;
      source: string;
      mint: string | null;
      kind: string;
      observed_at: Date;
      payload: unknown;
    }>(
      'SELECT id::text AS id, source, mint, kind, observed_at, payload FROM signals WHERE ($2::text IS NULL OR source = $2) ORDER BY id DESC LIMIT $1',
      [clampLimit(limit, 100), source],
    );
    return res.rows.map((r) => ({
      id: r.id,
      source: r.source,
      mint: r.mint,
      kind: r.kind,
      observedAt: r.observed_at.toISOString(),
      payload: r.payload,
    }));
  }

  /** Runs a full audit-chain verification and caches the result. */
  async refreshAuditValidity(): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- multi-line assignment reads better as a guard
    if (!this.auditRefresh) {
      this.auditRefresh = this.audit
        .verify()
        .then((r) => {
          this.auditCache = { at: Date.now(), ok: r.ok };
          return r.ok;
        })
        .finally(() => {
          this.auditRefresh = null;
        });
    }
    return this.auditRefresh;
  }

  async metrics(): Promise<MetricsDto> {
    const now = this.clock.now();
    const mode = await this.activeMode();
    const hourAgo = new Date(now.getTime() - 3600_000);
    const dayAgo = new Date(now.getTime() - 86_400_000);

    const lat = await this.pool.query<{ ms: number }>(
      `SELECT extract(epoch FROM (submitted_at - signal_at)) * 1000 AS ms FROM orders
        WHERE mode = $1 AND submitted_at IS NOT NULL AND signal_at IS NOT NULL AND submitted_at >= $2 AND submitted_at <= $3
          AND submitted_at >= signal_at
        ORDER BY ms LIMIT 10000`,
      [mode, hourAgo, now],
    );
    const sorted = lat.rows.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n));

    const landing = (
      await this.pool.query<{ landed: string; failed: string }>(
        `SELECT count(*) FILTER (WHERE status = 'landed')::text AS landed, count(*) FILTER (WHERE status = 'failed')::text AS failed
         FROM orders WHERE mode = $1 AND coalesce(submitted_at, created_at) >= $2`,
        [mode, hourAgo],
      )
    ).rows[0]!;
    const landed = Number(landing.landed);
    const failed = Number(landing.failed);

    const fresh = await this.pool.query<{ source: string; last: Date }>(
      `SELECT source, max(observed_at) AS last FROM signals WHERE observed_at >= $1 GROUP BY source`,
      [dayAgo],
    );
    const dataFreshnessSeconds: Record<string, number | null> = {};
    for (const s of this.knownSources) dataFreshnessSeconds[s] = null;
    for (const r of fresh.rows)
      dataFreshnessSeconds[r.source] = Math.max(0, Math.round((now.getTime() - r.last.getTime()) / 1000));

    const rec = (
      await this.pool.query<{ at: Date; ok: boolean; diff_lamports: string | null }>(
        'SELECT at, ok, diff_lamports FROM reconciliation_runs WHERE mode = $1 ORDER BY id DESC LIMIT 1',
        [mode],
      )
    ).rows[0];

    const trades = (
      await this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM positions WHERE mode = $1 AND status = 'closed' AND closed_at >= $2`,
        [mode, dayAgo],
      )
    ).rows[0]!;

    if (!this.auditCache || Date.now() - this.auditCache.at > this.auditTtlMs) {
      // Refresh in the background; report the last known value meanwhile.
      this.refreshAuditValidity().catch(() => undefined);
    }

    const rpc = this.rpcHealth();
    return {
      latencyMs: {
        signalToSubmit: { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) },
      },
      landingRate: landed + failed > 0 ? landed / (landed + failed) : null,
      rpc: { healthy: rpc.healthy, lastOkAt: rpc.lastOkAt, errorRate: rpc.errorRate },
      dataFreshnessSeconds,
      reconciliation: rec
        ? { lastRunAt: rec.at.toISOString(), ok: rec.ok, diffLamports: rec.diff_lamports }
        : { lastRunAt: null, ok: null, diffLamports: null },
      auditChainValid: this.auditCache ? this.auditCache.ok : null,
      tradesLast24h: Number(trades.n),
    };
  }
}
