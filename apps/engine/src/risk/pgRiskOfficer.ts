import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PublicKey } from '@solana/web3.js';
import {
  Base58Address,
  LIVE_MODE_CONFIRMATION,
  bpsOf,
  getPreset,
  type EngineState,
  type HaltReason,
  type Preset,
  type PresetName,
  type TradingMode,
} from '@tidepool/core';
import { signTicket, type ReservationTicket, type SignedTicket } from '@tidepool/core/ticket';
import type {
  Clock,
  ExitReport,
  FillReport,
  OpenPositionView,
  ReservationDecision,
  ReservationRequest,
  RiskOfficer,
} from '../contracts.js';
import { systemClock } from '../contracts.js';
import type { PgAuditLog, AuditInput, AuditActor } from '../audit/pgAuditLog.js';
import type { Alert, Alerter, DailySummary } from '../alerts/alerter.js';
import { NullAlerter } from '../alerts/alerter.js';
import { storableString } from '../audit/canonical.js';
import type { Logger } from '../log.js';
import { toBig, toBigOrNull } from '../db/pool.js';
import type { EngineConfig } from '../config.js';
import { WITHDRAWAL_SLEEVE, loadBookTotals, utcDate, type BookTotals } from './book.js';
import { tokenSafetyVeto } from './safety.js';

export interface RiskOfficerSettings {
  liveTradingEnabled: boolean;
  /** True when the signer URL and token are configured (required to switch to live). */
  signerConfigured: boolean;
  reservationTtlMs: number;
  exitTicketTtlMs: number;
  withdrawTicketTtlMs: number;
  /**
   * Live mode only: how long a hold outlives its ticket. A transaction signed just before the ticket
   * expires can still land until its blockhash expires (about 60-90 s), so the funds stay held.
   */
  landingGraceMs: number;
  /** Max SOL a sell transaction may move out of the wallet (fees, temporary account rent), excluding tip. */
  exitFeeAllowanceLamports: bigint;
  reconcileToleranceLamports: bigint;
  /** Consecutive reconciliation runs that may be deferred while in-flight transactions explain a difference. */
  reconcileMaxDeferrals: number;
  /** Consecutive chain-fetch failures before halting with rpc_errors. */
  reconcileMaxFetchFailures: number;
  withdrawTimelockMs: number;
  configVersion: string;
  /** Paper pool funding applied automatically on the first start of an empty paper book. 0 disables. */
  paperStartingLamports: bigint;
}

export const DEFAULT_RISK_SETTINGS: RiskOfficerSettings = {
  liveTradingEnabled: false,
  signerConfigured: false,
  reservationTtlMs: 60_000,
  exitTicketTtlMs: 60_000,
  withdrawTicketTtlMs: 5 * 60_000,
  landingGraceMs: 90_000,
  exitFeeAllowanceLamports: 10_000_000n,
  reconcileToleranceLamports: 0n,
  reconcileMaxDeferrals: 3,
  reconcileMaxFetchFailures: 5,
  withdrawTimelockMs: 24 * 3600_000,
  configVersion: 'dev',
  paperStartingLamports: 0n,
};

export function riskSettingsFromConfig(cfg: EngineConfig): RiskOfficerSettings {
  return {
    ...DEFAULT_RISK_SETTINGS,
    liveTradingEnabled: cfg.liveTradingEnabled,
    signerConfigured: cfg.signer !== null && cfg.ticketSecret !== null,
    reservationTtlMs: cfg.risk.reservationTtlSeconds * 1000,
    reconcileToleranceLamports: cfg.risk.reconcileToleranceLamports,
    withdrawTimelockMs: cfg.risk.withdrawTimelockHours * 3600_000,
    configVersion: cfg.configVersion,
    paperStartingLamports: cfg.paperStartingLamports,
  };
}

export interface PgRiskOfficerOptions {
  pool: pg.Pool;
  audit: PgAuditLog;
  mode: TradingMode;
  clock?: Clock;
  /** Resolves a preset by name; defaults to the built-in presets. The active name lives in pool_state. */
  preset?: (name: PresetName) => Preset;
  /** HMAC secret for reservation tickets. Required (>= 32 chars) in live mode. */
  ticketSecret?: string | null;
  solUsd?: () => number | null;
  config?: Partial<RiskOfficerSettings>;
  alerter?: Alerter;
  logger?: Logger;
}

export type ControlResult = { ok: true; state: EngineState; haltReason: HaltReason | null } | { ok: false; reason: string };

export interface OpenPositionDetail extends OpenPositionView {
  status: 'open' | 'closing';
  markLamports: bigint | null;
}

export type ReconcileResult =
  | { status: 'ok'; ledgerLamports: bigint; chainLamports: bigint | null; diffLamports: bigint }
  | { status: 'mismatch'; ledgerLamports: bigint; chainLamports: bigint | null; diffLamports: bigint; detail: string }
  | { status: 'deferred'; reason: string }
  | { status: 'error'; reason: string };

export type WithdrawResult =
  | { ok: true; withdrawalId: string; lamports: bigint; destination: string; ticket: SignedTicket | null }
  | { ok: false; reason: string };

interface StateRow {
  engineState: EngineState;
  haltReason: HaltReason | null;
  preset: PresetName;
  cash: bigint;
  peak: bigint;
  sod: bigint;
  sodDate: string | null;
}

interface Tx {
  client: pg.PoolClient;
  now: Date;
  events: AuditInput[];
  alerts: Alert[];
}

interface ReservationRow {
  id: string;
  idempotency_key: string;
  sleeve: string;
  mint: string;
  lamports: string;
  status: 'held' | 'filled' | 'released' | 'expired';
  created_at: Date;
  expires_at: Date;
}

const RETRYABLE = new Set(['40001', '40P01']);
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const SLEEVE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LAMPORTS = (1n << 62n);
const EXIT_REASONS = new Set<ExitReport['reason']>(['take_profit', 'stop_loss', 'time_stop', 'kill_switch', 'manual', 'filter_change']);
const PRESET_NAMES = new Set<PresetName>(['conservative', 'balanced', 'aggressive']);

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

function assertLamports(v: unknown, name: string, allowZero = false): bigint {
  if (typeof v !== 'bigint') throw new RiskError(`${name} must be a bigint`);
  if (v < 0n || (!allowZero && v === 0n) || v >= MAX_LAMPORTS) throw new RiskError(`${name} out of range`);
  return v;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_SYMBOL_CHARS = 64;

/** Makes an untrusted token symbol storable: strips control characters and caps the length. */
export function cleanSymbol(v: unknown): string {
  if (typeof v !== 'string') return '?';
  const chars = [...storableString(v.replace(CONTROL_CHARS, ''))].slice(0, MAX_SYMBOL_CHARS);
  const out = chars.join('').trim();
  return out.length > 0 ? out : '?';
}

function withdrawAddressRef(address: string): string {
  return `withdraw_address:${address}`;
}

function isValidAddress(addr: string): boolean {
  if (!Base58Address.safeParse(addr).success) return false;
  try {
    return new PublicKey(addr).toBase58() === addr;
  } catch {
    return false;
  }
}

/**
 * The Risk Officer for one trading mode. It is the only writer of pool_state cash, reservations,
 * positions and ledger_entries. Every money-moving method runs in one database transaction that
 * first locks this mode's pool_state row (FOR UPDATE), so all ledger writes for a mode are
 * serialized and reservations can never over-allocate. Audit events are appended inside the same
 * transaction, after all row changes, so a ledger change and its audit record commit together.
 * Lock order everywhere: pool_state row, then settings row, then the audit advisory lock.
 */
export class PgRiskOfficer implements RiskOfficer {
  private readonly pool: pg.Pool;
  private readonly audit: PgAuditLog;
  private readonly tradingMode: TradingMode;
  private readonly clock: Clock;
  private readonly presetFor: (name: PresetName) => Preset;
  private readonly ticketSecret: string | null;
  private readonly solUsd: () => number | null;
  private readonly cfg: RiskOfficerSettings;
  private readonly alerter: Alerter;
  private readonly log: Logger | undefined;
  private reconcileDeferrals = 0;
  private reconcileFetchFailures = 0;

  constructor(opts: PgRiskOfficerOptions) {
    if (opts.mode !== 'paper' && opts.mode !== 'live') throw new RiskError('invalid trading mode');
    this.pool = opts.pool;
    this.audit = opts.audit;
    this.tradingMode = opts.mode;
    this.clock = opts.clock ?? systemClock;
    this.presetFor = opts.preset ?? getPreset;
    this.solUsd = opts.solUsd ?? (() => null);
    this.cfg = { ...DEFAULT_RISK_SETTINGS, ...(opts.config ?? {}) };
    this.alerter = opts.alerter ?? new NullAlerter();
    this.log = opts.logger;
    const secret = opts.ticketSecret ?? null;
    if (opts.mode === 'live') {
      if (!secret || secret.length < 32) throw new RiskError('live mode requires a ticket secret of at least 32 characters');
      this.ticketSecret = secret;
    } else {
      this.ticketSecret = null; // paper mode never issues tickets
    }
  }

  mode(): TradingMode {
    return this.tradingMode;
  }

  // ---------------------------------------------------------------------------------------------
  // Transaction plumbing
  // ---------------------------------------------------------------------------------------------

  private async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.pool.connect();
      const tx: Tx = { client, now: this.clock.now(), events: [], alerts: [] };
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        for (const e of tx.events) await this.audit.appendWith(client, { at: tx.now, ...e });
        await client.query('COMMIT');
        for (const a of tx.alerts) this.dispatchAlert(a);
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (err as { code?: string }).code;
        if (attempt < 3 && code && RETRYABLE.has(code)) continue;
        throw err;
      } finally {
        client.release();
      }
    }
  }

  private dispatchAlert(a: Alert): void {
    this.alerter.notify(a).catch((err: unknown) => {
      this.log?.warn({ error: err instanceof Error ? err.name : 'unknown' }, 'alert dispatch failed');
    });
  }

  private event(tx: Tx, type: string, ref: string | null, payload: Record<string, unknown>, actor: AuditActor = 'risk'): void {
    tx.events.push({ actor, type, ref, payload: { mode: this.tradingMode, ...payload } });
  }

  private async lockState(tx: Tx): Promise<StateRow> {
    const res = await tx.client.query<{
      engine_state: EngineState; halt_reason: string | null; preset: PresetName; cash_lamports: string;
      peak_equity_lamports: string; sod_equity_lamports: string; sod_date: string | null;
    }>(
      `SELECT engine_state, halt_reason, preset, cash_lamports, peak_equity_lamports, sod_equity_lamports, to_char(sod_date, 'YYYY-MM-DD') AS sod_date
         FROM pool_state WHERE mode = $1 FOR UPDATE`,
      [this.tradingMode],
    );
    const r = res.rows[0];
    if (!r) throw new RiskError(`pool_state row missing for mode ${this.tradingMode}`);
    return {
      engineState: r.engine_state,
      haltReason: r.halt_reason as HaltReason | null,
      preset: r.preset,
      cash: toBig(r.cash_lamports),
      peak: toBig(r.peak_equity_lamports),
      sod: toBig(r.sod_equity_lamports),
      sodDate: r.sod_date,
    };
  }

  private async saveState(tx: Tx, s: StateRow): Promise<void> {
    await tx.client.query(
      `UPDATE pool_state SET engine_state = $2, halt_reason = $3, preset = $4, cash_lamports = $5,
              peak_equity_lamports = $6, sod_equity_lamports = $7, sod_date = $8::date, updated_at = $9
        WHERE mode = $1`,
      [this.tradingMode, s.engineState, s.haltReason, s.preset, s.cash.toString(), s.peak.toString(), s.sod.toString(), s.sodDate, tx.now],
    );
  }

  private async ledger(tx: Tx, kind: 'deposit' | 'withdraw' | 'buy' | 'sell' | 'fee' | 'adjustment', lamports: bigint, ref: string | null, note: string | null): Promise<void> {
    if (lamports === 0n) return;
    await tx.client.query(
      'INSERT INTO ledger_entries (mode, at, kind, lamports, ref, note) VALUES ($1, $2, $3, $4, $5, $6)',
      [this.tradingMode, tx.now, kind, lamports.toString(), ref, note],
    );
  }

  private presetOf(s: StateRow): Preset {
    return this.presetFor(s.preset);
  }

  /** Extra lifetime of a hold beyond its ticket (live only; paper fills are synchronous). */
  private holdGraceMs(): number {
    return this.tradingMode === 'live' ? this.cfg.landingGraceMs : 0;
  }

  /**
   * Rolls the day (and peak) on the book as it stands before the caller changes it, so a loss
   * observed at the first touch of a new UTC day counts against that day instead of being folded
   * into its start-of-day snapshot. Caller must hold the pool_state lock.
   */
  private async rollOnCurrentBook(tx: Tx, s: StateRow): Promise<void> {
    const book = await loadBookTotals(tx.client, this.tradingMode);
    this.rollDay(tx, s, s.cash + book.inPositionsLamports);
  }

  /** Expires held reservations past their deadline. Caller must hold the pool_state lock. */
  private async expireStale(tx: Tx): Promise<number> {
    const res = await tx.client.query<{ id: string; lamports: string; sleeve: string }>(
      `UPDATE reservations SET status = 'expired', settled_at = $2
        WHERE mode = $1 AND status = 'held' AND expires_at <= $2 RETURNING id, lamports, sleeve`,
      [this.tradingMode, tx.now],
    );
    for (const r of res.rows) this.event(tx, 'reservation_expired', r.id, { lamports: r.lamports, sleeve: r.sleeve });
    return res.rowCount ?? 0;
  }

  /**
   * Rolls the start-of-day snapshot at the first touch of a new UTC day, auto-clears a daily loss
   * halt, and tracks peak equity. Caller must hold the pool_state lock.
   */
  private rollDay(tx: Tx, s: StateRow, equity: bigint): void {
    const today = utcDate(tx.now);
    if (s.sodDate !== today) {
      const previous = s.sodDate;
      s.sodDate = today;
      s.sod = equity;
      this.event(tx, 'day_rolled', null, { date: today, previousDate: previous, startOfDayEquity: equity });
      if (s.haltReason === 'daily_loss_limit') {
        s.haltReason = null;
        if (s.engineState === 'halted') s.engineState = 'running';
        this.event(tx, 'halt_auto_cleared', null, { reason: 'daily_loss_limit', newState: s.engineState });
        tx.alerts.push({ kind: 'halt_cleared', severity: 'info', mode: this.tradingMode, title: 'Daily loss halt cleared', body: `New UTC day ${today}; trading state is ${s.engineState}.` });
      }
    }
    if (equity > s.peak) s.peak = equity;
  }

  /** Sets a halt. Returns true when the state changed. Caller must hold the pool_state lock. */
  private applyHalt(tx: Tx, s: StateRow, reason: HaltReason, detail: string, actor: AuditActor = 'risk'): boolean {
    if (s.engineState === 'halted' && s.haltReason === reason) return false;
    if (s.engineState === 'halted' && s.haltReason !== null && s.haltReason !== 'daily_loss_limit' && reason !== 'kill_switch') {
      // Keep the existing, stronger halt; record the additional trigger.
      this.event(tx, 'halt_additional_trigger', null, { reason, detail, activeReason: s.haltReason }, actor);
      return false;
    }
    const previous = { state: s.engineState, reason: s.haltReason };
    s.engineState = 'halted';
    s.haltReason = reason;
    this.event(tx, 'halted', null, { reason, detail, previous }, actor);
    tx.alerts.push({
      kind: reason === 'kill_switch' ? 'kill_switch' : reason === 'reconciliation_mismatch' ? 'reconciliation_error' : 'halt',
      severity: 'critical',
      mode: this.tradingMode,
      title: reason === 'kill_switch' ? 'Kill switch used: selling all positions' : `Trading halted: ${reason}`,
      body: detail,
      haltReason: reason,
    });
    return true;
  }

  /**
   * Enforces the daily loss and drawdown limits against current equity. Returns the breached
   * limit or null. Caller must hold the pool_state lock.
   */
  private enforceLimits(tx: Tx, s: StateRow, equity: bigint): 'daily_loss_limit' | 'drawdown_limit' | null {
    const limits = this.presetOf(s).limits;
    let breached: 'daily_loss_limit' | 'drawdown_limit' | null = null;
    const pnl = equity - s.sod;
    const dailyLimit = bpsOf(s.sod, limits.dailyLossLimitBps);
    if (s.sod > 0n && pnl < 0n && -pnl >= dailyLimit) {
      breached = 'daily_loss_limit';
      const detail = `Today's P&L ${pnl} lamports reached the daily loss limit of -${dailyLimit} lamports.`;
      if (s.engineState === 'running' || s.engineState === 'halted') {
        this.applyHalt(tx, s, 'daily_loss_limit', detail);
      } else if (s.haltReason === null) {
        // Paused or stopped: keep the operator's state, but mark entries blocked for the day.
        s.haltReason = 'daily_loss_limit';
        this.event(tx, 'daily_loss_limit_marked', null, { detail, state: s.engineState });
      }
    }
    const drawdown = s.peak - equity;
    const ddLimit = bpsOf(s.peak, limits.maxDrawdownBps);
    if (s.peak > 0n && drawdown > 0n && drawdown >= ddLimit) {
      breached = 'drawdown_limit';
      this.applyHalt(tx, s, 'drawdown_limit', `Drawdown ${drawdown} lamports from peak ${s.peak} reached the limit of ${ddLimit} lamports. Operator review required.`);
    }
    return breached;
  }

  private async activeMode(q: pg.PoolClient | pg.Pool): Promise<TradingMode> {
    const r = await q.query<{ active_mode: TradingMode }>('SELECT active_mode FROM settings WHERE id = 1');
    return r.rows[0]?.active_mode ?? 'paper';
  }

  // ---------------------------------------------------------------------------------------------
  // Reservations
  // ---------------------------------------------------------------------------------------------

  private idemRef(key: string): string {
    return `reserve:${this.tradingMode}:${key}`;
  }

  private validateRequest(req: ReservationRequest): string | null {
    if (!req || typeof req !== 'object') return 'invalid_request';
    if (typeof req.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(req.idempotencyKey)) return 'invalid_request:idempotency_key';
    if (typeof req.sleeve !== 'string' || !SLEEVE_NAME.test(req.sleeve) || req.sleeve === WITHDRAWAL_SLEEVE) return 'invalid_request:sleeve';
    if (typeof req.mint !== 'string' || !Base58Address.safeParse(req.mint).success) return 'invalid_request:mint';
    if (typeof req.lamports !== 'bigint' || req.lamports <= 0n || req.lamports >= MAX_LAMPORTS) return 'invalid_request:lamports';
    if (!req.candidate || req.candidate.mint !== req.mint) return 'invalid_request:candidate_mismatch';
    if (typeof req.positionShareOfLiquidity !== 'number' || !Number.isFinite(req.positionShareOfLiquidity) || req.positionShareOfLiquidity < 0) {
      return 'invalid_request:liquidity_share';
    }
    return null;
  }

  private buyTicket(row: { id: string; mint: string; lamports: bigint; createdAt: Date; expiresAt: Date }, preset: Preset): SignedTicket | null {
    if (this.tradingMode !== 'live' || !this.ticketSecret) return null;
    const tip = preset.strategy.tipLamports;
    const ticket: ReservationTicket = {
      v: 1,
      reservationId: row.id,
      intent: 'buy',
      mint: row.mint,
      maxLamports: (row.lamports - tip).toString(),
      maxTipLamports: tip.toString(),
      destination: null,
      issuedAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
    };
    return signTicket(ticket, this.ticketSecret);
  }

  async reserve(req: ReservationRequest): Promise<ReservationDecision> {
    const invalid = this.validateRequest(req);
    if (invalid) {
      await this.audit.append({
        actor: 'risk', type: 'reservation_vetoed', ref: null,
        payload: { mode: this.tradingMode, reason: invalid, mint: typeof req?.mint === 'string' ? req.mint.slice(0, 64) : null },
      });
      return { approved: false, reason: invalid };
    }
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      await this.expireStale(tx);

      // Idempotency: a repeated key returns the original decision while it is still usable.
      const existing = await tx.client.query<ReservationRow>(
        'SELECT id, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at FROM reservations WHERE mode = $1 AND idempotency_key = $2',
        [this.tradingMode, req.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.mint !== req.mint || prior.sleeve !== req.sleeve || toBig(prior.lamports) !== req.lamports) {
          return this.veto(tx, s, req, 'idempotency_key_conflict', false);
        }
        // A released, expired or filled reservation must never be handed out again: that would
        // re-issue a spendable ticket after a kill switch, a halt release or an earlier fill.
        if (prior.status !== 'held') return this.veto(tx, s, req, `reservation_${prior.status}`, false);
        const ticketExpiresAt = new Date(prior.expires_at.getTime() - this.holdGraceMs());
        if (ticketExpiresAt.getTime() <= tx.now.getTime()) return this.veto(tx, s, req, 'reservation_expired', false);
        const lamports = toBig(prior.lamports);
        return {
          approved: true,
          reservationId: prior.id,
          lamports,
          ticket: this.buyTicket({ id: prior.id, mint: prior.mint, lamports, createdAt: prior.created_at, expiresAt: ticketExpiresAt }, this.presetOf(s)),
          expiresAt: ticketExpiresAt,
        };
      }
      const priorVeto = await tx.client.query<{ payload: { reason?: string; mint?: string; lamports?: string } }>(
        `SELECT payload FROM audit_events WHERE ref = $1 AND type = 'reservation_vetoed' ORDER BY seq DESC LIMIT 1`,
        [this.idemRef(req.idempotencyKey)],
      );
      const pv = priorVeto.rows[0]?.payload;
      if (pv && typeof pv.reason === 'string') {
        if (pv.mint === req.mint && pv.lamports === req.lamports.toString()) return { approved: false, reason: pv.reason };
        return this.veto(tx, s, req, 'idempotency_key_conflict', false);
      }

      const book = await loadBookTotals(tx.client, this.tradingMode);
      const equity = s.cash + book.inPositionsLamports;
      this.rollDay(tx, s, equity);
      const preset = this.presetOf(s);
      const { limits, filters } = preset;

      // 1. Engine state.
      if (s.engineState !== 'running') {
        const reason = s.engineState === 'halted' ? `halted:${s.haltReason ?? 'unknown'}` : `engine_${s.engineState}`;
        return this.veto(tx, s, req, reason);
      }
      if (s.haltReason !== null) return this.veto(tx, s, req, `halted:${s.haltReason}`);
      // 2-3. Daily loss and drawdown limits (may halt).
      const breached = this.enforceLimits(tx, s, equity);
      if (breached) return this.veto(tx, s, req, breached);
      // 4. Cooldown for this mint.
      const cd = await tx.client.query('SELECT 1 FROM cooldowns WHERE mode = $1 AND mint = $2 AND until > $3', [this.tradingMode, req.mint, tx.now]);
      if (cd.rowCount) return this.veto(tx, s, req, 'cooldown');
      // 5. Max open positions (open + closing positions + held entry reservations).
      if (book.openCount + book.closingCount + book.heldEntryCount >= limits.maxOpenPositions) return this.veto(tx, s, req, 'max_open_positions');
      // 6. Per-position cap.
      if (req.lamports > bpsOf(equity, limits.maxPositionBps)) return this.veto(tx, s, req, 'max_position_size');
      // 7. Per-token exposure cap (cost basis of open positions plus held reservations in this mint).
      const tok = await tx.client.query<{ exposure: string }>(
        `SELECT ((SELECT coalesce(sum(entry_lamports), 0) FROM positions WHERE mode = $1 AND mint = $2 AND status <> 'closed')
               + (SELECT coalesce(sum(lamports), 0) FROM reservations WHERE mode = $1 AND mint = $2 AND status = 'held'))::text AS exposure`,
        [this.tradingMode, req.mint],
      );
      if (toBig(tok.rows[0]!.exposure) + req.lamports > bpsOf(equity, limits.maxPerTokenBps)) return this.veto(tx, s, req, 'max_token_exposure');
      // 8. Sleeve headroom.
      const sl = await tx.client.query<{ alloc_bps: number; used: string }>(
        `SELECT s.alloc_bps,
                ((SELECT coalesce(sum(entry_lamports), 0) FROM positions WHERE mode = $1 AND strategy = $2 AND status <> 'closed')
               + (SELECT coalesce(sum(lamports), 0) FROM reservations WHERE mode = $1 AND sleeve = $2 AND status = 'held'))::text AS used
           FROM sleeves s WHERE s.mode = $1 AND s.name = $2`,
        [this.tradingMode, req.sleeve],
      );
      const sleeve = sl.rows[0];
      if (!sleeve) return this.veto(tx, s, req, 'unknown_sleeve');
      if (toBig(sleeve.used) + req.lamports > bpsOf(equity, sleeve.alloc_bps)) return this.veto(tx, s, req, 'sleeve_headroom');
      // 9. Free cash after fee reserve and held reservations.
      const free = s.cash - limits.feeReserveLamports - book.heldLamports;
      if (req.lamports > free) return this.veto(tx, s, req, 'insufficient_free_cash');
      // 10. Position share of liquidity (the larger of the Trader's estimate and our own).
      let share = req.positionShareOfLiquidity;
      const solUsd = this.solUsd();
      const liq = req.candidate.safety?.liquidityUsd;
      if (solUsd !== null && Number.isFinite(solUsd) && solUsd > 0 && typeof liq === 'number' && Number.isFinite(liq) && liq > 0) {
        share = Math.max(share, (Number(req.lamports) / 1e9) * solUsd / liq);
      }
      if (share > filters.maxPositionShareOfLiquidity) return this.veto(tx, s, req, 'liquidity_share');
      // 11. Token safety re-check and candidate freshness.
      const expiresMs = Date.parse(req.candidate.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= tx.now.getTime()) return this.veto(tx, s, req, 'candidate_expired');
      const unsafe = tokenSafetyVeto(req.candidate, filters, tx.now);
      if (unsafe) return this.veto(tx, s, req, unsafe);
      // Live ticket preconditions.
      if (this.tradingMode === 'live') {
        if (!this.ticketSecret) return this.veto(tx, s, req, 'signer_not_configured');
        if (req.lamports <= preset.strategy.tipLamports) return this.veto(tx, s, req, 'reservation_below_tip');
      }

      const id = randomUUID();
      const expiresAt = new Date(tx.now.getTime() + this.cfg.reservationTtlMs);
      const holdExpiresAt = new Date(expiresAt.getTime() + this.holdGraceMs());
      await tx.client.query(
        `INSERT INTO reservations (id, mode, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'held', $7, $8)`,
        [id, this.tradingMode, req.idempotencyKey, req.sleeve, req.mint, req.lamports.toString(), tx.now, holdExpiresAt],
      );
      await this.saveState(tx, s);
      this.event(tx, 'reservation_approved', id, {
        idempotencyKey: req.idempotencyKey, sleeve: req.sleeve, mint: req.mint, symbol: req.candidate.symbol,
        lamports: req.lamports, score: req.candidate.score, equity, freeCashBefore: free, liquidityShare: share,
        expiresAt: expiresAt.toISOString(), holdExpiresAt: holdExpiresAt.toISOString(), preset: preset.name,
      });
      return {
        approved: true,
        reservationId: id,
        lamports: req.lamports,
        ticket: this.buyTicket({ id, mint: req.mint, lamports: req.lamports, createdAt: tx.now, expiresAt }, preset),
        expiresAt,
      };
    });
  }

  private async veto(tx: Tx, s: StateRow, req: ReservationRequest, reason: string, recordForReplay = true): Promise<ReservationDecision> {
    await this.saveState(tx, s);
    this.event(tx, 'reservation_vetoed', recordForReplay ? this.idemRef(req.idempotencyKey) : null, {
      reason, idempotencyKey: req.idempotencyKey, sleeve: req.sleeve, mint: req.mint, symbol: req.candidate?.symbol ?? null,
      lamports: req.lamports.toString(), score: req.candidate?.score ?? null,
    });
    return { approved: false, reason };
  }

  async recordFill(fill: FillReport): Promise<{ positionId: string }> {
    if (!fill || typeof fill.reservationId !== 'string' || !UUID.test(fill.reservationId)) throw new RiskError('invalid reservationId');
    const spent = assertLamports(fill.lamportsSpent, 'lamportsSpent');
    const tokens = assertLamports(fill.tokenAmount, 'tokenAmount', true);
    // The fill already happened on chain, so descriptive fields are cleaned up rather than rejected:
    // a token symbol comes from untrusted token metadata and must not make the buy unbookable.
    const priceOk = typeof fill.entryPriceUsd === 'number' && Number.isFinite(fill.entryPriceUsd) && fill.entryPriceUsd >= 0;
    const entryPriceUsd = priceOk ? fill.entryPriceUsd : 0;
    const symbol = cleanSymbol(fill.symbol);
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const r = (await tx.client.query<ReservationRow>(
        'SELECT id, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at FROM reservations WHERE id = $1 AND mode = $2 FOR UPDATE',
        [fill.reservationId, this.tradingMode],
      )).rows[0];
      if (!r) throw new RiskError('unknown reservation');
      if (r.sleeve === WITHDRAWAL_SLEEVE) throw new RiskError('reservation is a withdrawal hold');
      if (r.status === 'filled') {
        const p = await tx.client.query<{ id: string }>('SELECT id FROM positions WHERE reservation_id = $1', [r.id]);
        if (p.rows[0]) return { positionId: p.rows[0].id };
        throw new RiskError('reservation filled without a position');
      }
      if (r.mint !== fill.mint) throw new RiskError('fill mint does not match reservation');
      if (spent > s.cash) throw new RiskError('fill exceeds booked cash; reconcile before recording');
      const reserved = toBig(r.lamports);
      const late = r.status !== 'held';
      const positionId = randomUUID();
      const killActive = s.engineState === 'halted' && s.haltReason === 'kill_switch';
      s.cash -= spent;
      await tx.client.query(
        `INSERT INTO positions (id, mode, reservation_id, mint, symbol, strategy, status, entry_lamports, token_amount, entry_price_usd, opened_at, config_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [positionId, this.tradingMode, r.id, r.mint, symbol, r.sleeve, killActive ? 'closing' : 'open', spent.toString(), tokens.toString(), entryPriceUsd, tx.now, this.cfg.configVersion],
      );
      await tx.client.query(`UPDATE reservations SET status = 'filled', settled_at = $2 WHERE id = $1`, [r.id, tx.now]);
      await this.ledger(tx, 'buy', -spent, positionId, `reservation ${r.id}`);
      await this.saveState(tx, s);
      this.event(tx, 'reservation_filled', positionId, {
        reservationId: r.id, orderId: fill.orderId, mint: r.mint, symbol, strategy: r.sleeve,
        lamportsSpent: spent, reservedLamports: reserved, remainderReleased: reserved > spent ? reserved - spent : 0n,
        tokenAmount: tokens, entryPriceUsd, entryPriceInvalid: !priceOk, signature: fill.signature, lateFill: late, priorStatus: r.status,
        configVersion: this.cfg.configVersion,
      });
      if (late || spent > reserved) {
        tx.alerts.push({
          kind: 'accounting_warning', severity: 'warning', mode: this.tradingMode, title: 'Fill outside a held reservation',
          body: `Reservation ${r.id} was ${r.status}; spent ${spent} of ${reserved} reserved lamports. The position was booked.`,
        });
      }
      return { positionId };
    });
  }

  async release(reservationId: string, reason: string, burnedFeeLamports: bigint = 0n): Promise<void> {
    if (typeof reservationId !== 'string' || !UUID.test(reservationId)) throw new RiskError('invalid reservationId');
    const burned = assertLamports(burnedFeeLamports, 'burnedFeeLamports', true);
    const why = String(reason ?? '').slice(0, 300);
    await this.run(async (tx) => {
      const s = await this.lockState(tx);
      const r = (await tx.client.query<ReservationRow>(
        'SELECT id, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at FROM reservations WHERE id = $1 AND mode = $2 FOR UPDATE',
        [reservationId, this.tradingMode],
      )).rows[0];
      if (!r) throw new RiskError('unknown reservation');
      if (r.status === 'filled') throw new RiskError('reservation already filled');
      const reserved = toBig(r.lamports);
      if (burned > reserved) throw new RiskError('burned fee exceeds the reservation');
      let feeBooked = false;
      if (burned > 0n) {
        const dup = await tx.client.query(`SELECT 1 FROM ledger_entries WHERE mode = $1 AND kind = 'fee' AND ref = $2`, [this.tradingMode, r.id]);
        if (!dup.rowCount) {
          if (burned > s.cash) throw new RiskError('burned fee exceeds booked cash');
          await this.rollOnCurrentBook(tx, s);
          s.cash -= burned;
          await this.ledger(tx, 'fee', -burned, r.id, `failed transaction: ${why}`.slice(0, 300));
          feeBooked = true;
        }
      }
      if (r.status !== 'held' && !feeBooked) return; // idempotent
      if (r.status === 'held') {
        await tx.client.query(`UPDATE reservations SET status = 'released', settled_at = $2 WHERE id = $1`, [r.id, tx.now]);
      }
      if (feeBooked) {
        const book = await loadBookTotals(tx.client, this.tradingMode);
        const equity = s.cash + book.inPositionsLamports;
        this.rollDay(tx, s, equity);
        this.enforceLimits(tx, s, equity);
      }
      await this.saveState(tx, s);
      this.event(tx, 'reservation_released', r.id, { reason: why, burnedFeeLamports: feeBooked ? burned : 0n, lamports: reserved, priorStatus: r.status, mint: r.mint });
    });
  }

  /** Sweeper: expires held reservations past their deadline. Returns how many expired. */
  async expireStaleReservations(): Promise<number> {
    return this.run(async (tx) => {
      await this.lockState(tx);
      return this.expireStale(tx);
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Exits and marks (never blocked by halts)
  // ---------------------------------------------------------------------------------------------

  async authorizeExit(positionId: string, reason: ExitReport['reason']): Promise<{ ticket: SignedTicket | null }> {
    if (typeof positionId !== 'string' || !UUID.test(positionId)) throw new RiskError('invalid positionId');
    if (!EXIT_REASONS.has(reason)) throw new RiskError('invalid exit reason');
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const p = (await tx.client.query<{ id: string; mint: string; status: string }>(
        'SELECT id, mint, status FROM positions WHERE id = $1 AND mode = $2 FOR UPDATE', [positionId, this.tradingMode],
      )).rows[0];
      if (!p) throw new RiskError('unknown position');
      if (p.status === 'closed') throw new RiskError('position already closed');
      if (p.status === 'open') await tx.client.query(`UPDATE positions SET status = 'closing' WHERE id = $1`, [p.id]);
      let ticket: SignedTicket | null = null;
      let ticketId: string | null = null;
      if (this.tradingMode === 'live' && this.ticketSecret) {
        ticketId = randomUUID();
        ticket = signTicket({
          v: 1, reservationId: ticketId, intent: 'sell', mint: p.mint,
          maxLamports: this.cfg.exitFeeAllowanceLamports.toString(),
          maxTipLamports: this.presetOf(s).strategy.tipLamports.toString(),
          destination: null, issuedAt: tx.now.getTime(), expiresAt: tx.now.getTime() + this.cfg.exitTicketTtlMs,
        }, this.ticketSecret);
      }
      this.event(tx, 'exit_authorized', p.id, { reason, mint: p.mint, ticketId, haltState: s.engineState });
      return { ticket };
    });
  }

  async recordExit(exit: ExitReport): Promise<{ realizedPnlLamports: bigint }> {
    if (!exit || typeof exit.positionId !== 'string' || !UUID.test(exit.positionId)) throw new RiskError('invalid positionId');
    const received = assertLamports(exit.lamportsReceived, 'lamportsReceived', true);
    if (!EXIT_REASONS.has(exit.reason)) throw new RiskError('invalid exit reason');
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const p = (await tx.client.query<{ id: string; mint: string; symbol: string; status: string; entry_lamports: string; realized_pnl_lamports: string | null }>(
        'SELECT id, mint, symbol, status, entry_lamports, realized_pnl_lamports FROM positions WHERE id = $1 AND mode = $2 FOR UPDATE',
        [exit.positionId, this.tradingMode],
      )).rows[0];
      if (!p) throw new RiskError('unknown position');
      if (p.status === 'closed') return { realizedPnlLamports: toBig(p.realized_pnl_lamports) };
      const entry = toBig(p.entry_lamports);
      const realized = received - entry;
      await this.rollOnCurrentBook(tx, s);
      s.cash += received;
      await tx.client.query(
        `UPDATE positions SET status = 'closed', closed_at = $2, exit_lamports = $3, exit_reason = $4, realized_pnl_lamports = $5, mark_lamports = $3 WHERE id = $1`,
        [p.id, tx.now, received.toString(), exit.reason, realized.toString()],
      );
      await this.ledger(tx, 'sell', received, p.id, `exit ${exit.reason}`);
      if (exit.reason === 'stop_loss') {
        const until = new Date(tx.now.getTime() + this.presetOf(s).filters.cooldownAfterStopSeconds * 1000);
        await tx.client.query(
          `INSERT INTO cooldowns (mode, mint, until, reason) VALUES ($1, $2, $3, $4)
           ON CONFLICT (mode, mint) DO UPDATE SET until = GREATEST(cooldowns.until, EXCLUDED.until), reason = EXCLUDED.reason`,
          [this.tradingMode, p.mint, until, 'stop_loss'],
        );
      }
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const equity = s.cash + book.inPositionsLamports;
      this.rollDay(tx, s, equity);
      this.enforceLimits(tx, s, equity);
      await this.saveState(tx, s);
      this.event(tx, 'position_closed', p.id, {
        orderId: exit.orderId, mint: p.mint, symbol: p.symbol, reason: exit.reason, entryLamports: entry,
        lamportsReceived: received, realizedPnlLamports: realized, signature: exit.signature, equity,
      });
      return { realizedPnlLamports: realized };
    });
  }

  /** Books fees burned by a failed sell transaction against the position (the position stays open/closing). */
  async recordExitFailure(positionId: string, burnedFeeLamports: bigint, error: string): Promise<void> {
    if (typeof positionId !== 'string' || !UUID.test(positionId)) throw new RiskError('invalid positionId');
    const burned = assertLamports(burnedFeeLamports, 'burnedFeeLamports', true);
    await this.run(async (tx) => {
      const s = await this.lockState(tx);
      const p = (await tx.client.query<{ id: string; status: string }>(
        'SELECT id, status FROM positions WHERE id = $1 AND mode = $2 FOR UPDATE', [positionId, this.tradingMode],
      )).rows[0];
      if (!p) throw new RiskError('unknown position');
      if (burned > s.cash) throw new RiskError('burned fee exceeds booked cash');
      await this.rollOnCurrentBook(tx, s);
      s.cash -= burned;
      await this.ledger(tx, 'fee', -burned, p.id, `failed exit: ${String(error).slice(0, 200)}`);
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const equity = s.cash + book.inPositionsLamports;
      this.rollDay(tx, s, equity);
      this.enforceLimits(tx, s, equity);
      await this.saveState(tx, s);
      this.event(tx, 'exit_failed', p.id, { burnedFeeLamports: burned, error: String(error).slice(0, 300) });
    });
  }

  async markPositions(marks: Array<{ positionId: string; markLamports: bigint }>): Promise<void> {
    const ids: string[] = [];
    const vals: string[] = [];
    for (const m of marks) {
      if (typeof m.positionId !== 'string' || !UUID.test(m.positionId)) throw new RiskError('invalid positionId in marks');
      ids.push(m.positionId);
      vals.push(assertLamports(m.markLamports, 'markLamports', true).toString());
    }
    await this.run(async (tx) => {
      const s = await this.lockState(tx);
      const before = { state: s.engineState, reason: s.haltReason };
      await this.rollOnCurrentBook(tx, s);
      if (ids.length > 0) {
        await tx.client.query(
          `UPDATE positions p SET mark_lamports = m.mark
             FROM unnest($1::uuid[], $2::bigint[]) AS m(id, mark)
            WHERE p.id = m.id AND p.mode = $3 AND p.status <> 'closed'`,
          [ids, vals, this.tradingMode],
        );
      }
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const equity = s.cash + book.inPositionsLamports;
      this.rollDay(tx, s, equity);
      this.enforceLimits(tx, s, equity);
      await this.saveState(tx, s);
      if (before.state !== s.engineState || before.reason !== s.haltReason) {
        this.event(tx, 'marks_triggered_state_change', null, { equity, peak: s.peak, sod: s.sod, marks: ids.length });
      }
    });
  }

  async openPositions(): Promise<OpenPositionDetail[]> {
    const res = await this.pool.query<{
      id: string; mint: string; symbol: string; strategy: string; status: 'open' | 'closing'; entry_lamports: string;
      token_amount: string; entry_price_usd: number; opened_at: Date; mark_lamports: string | null;
    }>(
      `SELECT id, mint, symbol, strategy, status, entry_lamports, token_amount::text AS token_amount, entry_price_usd, opened_at, mark_lamports
         FROM positions WHERE mode = $1 AND status <> 'closed' ORDER BY opened_at`,
      [this.tradingMode],
    );
    return res.rows.map((r) => ({
      id: r.id, mint: r.mint, symbol: r.symbol, strategy: r.strategy, status: r.status,
      entryLamports: toBig(r.entry_lamports), tokenAmount: toBig(r.token_amount), entryPriceUsd: r.entry_price_usd,
      openedAt: r.opened_at, markLamports: toBigOrNull(r.mark_lamports),
    }));
  }

  // ---------------------------------------------------------------------------------------------
  // Halts and engine state
  // ---------------------------------------------------------------------------------------------

  async halt(reason: HaltReason, detail: string): Promise<void> {
    await this.run(async (tx) => {
      const s = await this.lockState(tx);
      this.applyHalt(tx, s, reason, String(detail).slice(0, 1000));
      await this.saveState(tx, s);
    });
  }

  async canOpenNewPositions(): Promise<{ ok: boolean; reason: string | null }> {
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const book = await loadBookTotals(tx.client, this.tradingMode);
      this.rollDay(tx, s, s.cash + book.inPositionsLamports);
      await this.saveState(tx, s);
      if (s.engineState !== 'running') return { ok: false, reason: s.engineState === 'halted' ? `halted:${s.haltReason ?? 'unknown'}` : `engine_${s.engineState}` };
      if (s.haltReason) return { ok: false, reason: `halted:${s.haltReason}` };
      return { ok: true, reason: null };
    });
  }

  async start(preset: PresetName, actor: AuditActor = 'owner'): Promise<ControlResult> {
    if (!PRESET_NAMES.has(preset)) return { ok: false, reason: 'unknown_preset' };
    this.presetFor(preset); // throws if the resolver does not know it
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      if ((await this.activeMode(tx.client)) !== this.tradingMode) return { ok: false, reason: 'mode_not_active' };
      if (s.engineState === 'halted' && s.haltReason !== 'daily_loss_limit') return { ok: false, reason: `halted:${s.haltReason ?? 'unknown'}` };
      if (this.tradingMode === 'paper' && this.cfg.paperStartingLamports > 0n) {
        const any = await tx.client.query('SELECT 1 FROM ledger_entries WHERE mode = $1 LIMIT 1', [this.tradingMode]);
        if (!any.rowCount) await this.fundInTx(tx, s, this.cfg.paperStartingLamports, actor);
      }
      const book = await loadBookTotals(tx.client, this.tradingMode);
      this.rollDay(tx, s, s.cash + book.inPositionsLamports);
      const previous = s.engineState;
      s.preset = preset;
      s.engineState = s.haltReason === 'daily_loss_limit' ? 'halted' : 'running';
      await this.saveState(tx, s);
      this.event(tx, 'engine_started', null, { preset, previous, state: s.engineState }, actor);
      return { ok: true, state: s.engineState, haltReason: s.haltReason };
    });
  }

  async pause(actor: AuditActor = 'owner'): Promise<ControlResult> {
    return this.transition('paused', actor);
  }

  async stop(actor: AuditActor = 'owner'): Promise<ControlResult> {
    return this.transition('stopped', actor);
  }

  private async transition(target: 'paused' | 'stopped', actor: AuditActor): Promise<ControlResult> {
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      if (s.engineState === 'halted' && s.haltReason !== 'daily_loss_limit') return { ok: false, reason: `halted:${s.haltReason ?? 'unknown'}` };
      if (s.engineState === target) return { ok: true, state: s.engineState, haltReason: s.haltReason };
      const previous = s.engineState;
      s.engineState = target; // a daily loss marker stays in halt_reason until the next UTC day
      await this.saveState(tx, s);
      this.event(tx, target === 'paused' ? 'engine_paused' : 'engine_stopped', null, { previous, haltReason: s.haltReason }, actor);
      return { ok: true, state: s.engineState, haltReason: s.haltReason };
    });
  }

  /**
   * Kill switch: halts with reason kill_switch, releases held entry reservations and marks every
   * open position 'closing' so the Trader sells it. Exits remain allowed. Withdrawal holds are kept:
   * their ticket may already be signed, so releasing them would let the same SOL be committed twice.
   */
  async killSwitch(actor: AuditActor = 'owner'): Promise<{ positionsClosing: number; reservationsReleased: number }> {
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const rel = await tx.client.query<{ id: string }>(
        `UPDATE reservations SET status = 'released', settled_at = $2 WHERE mode = $1 AND status = 'held' AND sleeve <> $3 RETURNING id`,
        [this.tradingMode, tx.now, WITHDRAWAL_SLEEVE],
      );
      await tx.client.query(`UPDATE positions SET status = 'closing' WHERE mode = $1 AND status = 'open'`, [this.tradingMode]);
      const closing = await tx.client.query<{ n: string }>(`SELECT count(*)::text AS n FROM positions WHERE mode = $1 AND status = 'closing'`, [this.tradingMode]);
      const positionsClosing = Number(closing.rows[0]!.n);
      const changed = this.applyHalt(tx, s, 'kill_switch', `Kill switch by ${actor}: ${positionsClosing} position(s) being sold, ${rel.rowCount ?? 0} reservation(s) released.`, actor);
      if (!changed) {
        // Already halted by the kill switch; still count as a fresh trigger in the log.
        this.event(tx, 'kill_switch_repeated', null, { positionsClosing }, actor);
      }
      for (const r of rel.rows) this.event(tx, 'reservation_released', r.id, { reason: 'kill_switch', burnedFeeLamports: '0' }, actor);
      await this.saveState(tx, s);
      return { positionsClosing, reservationsReleased: rel.rowCount ?? 0 };
    });
  }

  /** Operator clears a halt. The engine goes to 'paused'; someone must press Start again. */
  async clearHalt(reason: string, actor: AuditActor = 'operator'): Promise<ControlResult> {
    const why = String(reason ?? '').trim();
    if (why.length < 3 || why.length > 500) return { ok: false, reason: 'reason_required' };
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      if (s.haltReason === null && s.engineState !== 'halted') return { ok: false, reason: 'not_halted' };
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const equity = s.cash + book.inPositionsLamports;
      const cleared = s.haltReason;
      // Accepting the loss: re-base the limit that tripped so it does not re-trigger immediately.
      if (cleared === 'drawdown_limit') s.peak = equity;
      if (cleared === 'daily_loss_limit') s.sod = equity;
      s.haltReason = null;
      if (s.engineState === 'halted') s.engineState = 'paused';
      await this.saveState(tx, s);
      this.event(tx, 'halt_cleared', null, { cleared, reason: why, equity, newPeak: s.peak, newSod: s.sod }, actor);
      tx.alerts.push({ kind: 'halt_cleared', severity: 'warning', mode: this.tradingMode, title: `Halt cleared by ${actor}`, body: `Cleared ${cleared ?? 'halt'}: ${why}. Engine is ${s.engineState}.` });
      return { ok: true, state: s.engineState, haltReason: s.haltReason };
    });
  }

  /**
   * Switches the active trading mode. Going live needs LIVE_TRADING_ENABLED, a configured signer
   * and the exact confirmation phrase. Refused while the current mode has open positions or held
   * reservations. The previous mode is stopped (unless halted).
   */
  async setMode(target: TradingMode, confirm: string | undefined, actor: AuditActor = 'owner'): Promise<{ ok: true; mode: TradingMode } | { ok: false; reason: string }> {
    if (target !== 'paper' && target !== 'live') return { ok: false, reason: 'invalid_mode' };
    if (target === 'live') {
      if (!this.cfg.liveTradingEnabled) return { ok: false, reason: 'live_trading_disabled' };
      if (confirm !== LIVE_MODE_CONFIRMATION) return { ok: false, reason: 'confirmation_required' };
      if (!this.cfg.signerConfigured) return { ok: false, reason: 'signer_not_configured' };
    }
    const result = await this.run(async (tx) => {
      const current = await this.activeMode(tx.client);
      if (current === target) return { ok: true as const, mode: target, changed: false };
      const st = (await tx.client.query<{ engine_state: EngineState }>('SELECT engine_state FROM pool_state WHERE mode = $1 FOR UPDATE', [current])).rows[0];
      const settings = (await tx.client.query<{ active_mode: TradingMode }>('SELECT active_mode FROM settings WHERE id = 1 FOR UPDATE')).rows[0];
      if (!settings || settings.active_mode !== current) return { ok: false as const, reason: 'concurrent_mode_change' };
      const busy = await tx.client.query<{ n: string }>(
        `SELECT ((SELECT count(*) FROM positions WHERE mode = $1 AND status <> 'closed') + (SELECT count(*) FROM reservations WHERE mode = $1 AND status = 'held'))::text AS n`,
        [current],
      );
      if (Number(busy.rows[0]!.n) > 0) return { ok: false as const, reason: 'open_positions_or_reservations' };
      if (st && (st.engine_state === 'running' || st.engine_state === 'paused')) {
        await tx.client.query(`UPDATE pool_state SET engine_state = 'stopped', updated_at = $2 WHERE mode = $1`, [current, tx.now]);
      }
      await tx.client.query('UPDATE settings SET active_mode = $1, updated_at = $2 WHERE id = 1', [target, tx.now]);
      tx.events.push({ actor, type: 'mode_changed', ref: null, payload: { from: current, to: target } });
      tx.alerts.push({ kind: 'mode_change', severity: target === 'live' ? 'critical' : 'warning', mode: target, title: `Mode switched to ${target.toUpperCase()}`, body: `Switched from ${current} to ${target} by ${actor}.` });
      return { ok: true as const, mode: target, changed: true };
    });
    return result.ok ? { ok: true, mode: result.mode } : result;
  }

  // ---------------------------------------------------------------------------------------------
  // Funding, deposits and withdrawals
  // ---------------------------------------------------------------------------------------------

  private async fundInTx(tx: Tx, s: StateRow, lamports: bigint, actor: AuditActor): Promise<void> {
    s.cash += lamports;
    s.sod += lamports;
    s.peak += lamports;
    await this.ledger(tx, 'deposit', lamports, null, 'paper pool funding');
    this.event(tx, 'paper_pool_funded', null, { lamports }, actor);
  }

  /** Paper mode only: books simulated SOL into the paper pool as a deposit. */
  async fundPaperPool(lamports: bigint, actor: AuditActor = 'owner'): Promise<{ cashLamports: bigint }> {
    if (this.tradingMode !== 'paper') throw new RiskError('fundPaperPool is only available in paper mode');
    const amount = assertLamports(lamports, 'lamports');
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const book = await loadBookTotals(tx.client, this.tradingMode);
      this.rollDay(tx, s, s.cash + book.inPositionsLamports);
      await this.fundInTx(tx, s, amount, actor);
      await this.saveState(tx, s);
      return { cashLamports: s.cash };
    });
  }

  /**
   * Live mode reconciliation helper: books an on-chain deposit identified by its transaction
   * signature. Idempotent per signature.
   */
  async bookDeposit(lamports: bigint, signature: string, actor: AuditActor = 'system'): Promise<{ booked: boolean }> {
    const amount = assertLamports(lamports, 'lamports');
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(signature)) throw new RiskError('invalid signature');
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const dup = await tx.client.query(`SELECT 1 FROM ledger_entries WHERE mode = $1 AND kind = 'deposit' AND ref = $2`, [this.tradingMode, signature]);
      if (dup.rowCount) return { booked: false };
      const book = await loadBookTotals(tx.client, this.tradingMode);
      this.rollDay(tx, s, s.cash + book.inPositionsLamports);
      s.cash += amount;
      s.sod += amount;
      s.peak += amount;
      await this.ledger(tx, 'deposit', amount, signature, 'on-chain deposit');
      await this.saveState(tx, s);
      this.event(tx, 'deposit_booked', signature, { lamports: amount }, actor);
      tx.alerts.push({ kind: 'withdrawal', severity: 'info', mode: this.tradingMode, title: 'Deposit received', body: `${amount} lamports booked to the pool.` });
      return { booked: true };
    });
  }

  async setDepositAddress(address: string, actor: AuditActor = 'system'): Promise<void> {
    if (!isValidAddress(address)) throw new RiskError('invalid address');
    await this.run(async (tx) => {
      await tx.client.query('UPDATE settings SET deposit_address = $1, updated_at = $2 WHERE id = 1', [address, tx.now]);
      tx.events.push({ actor, type: 'deposit_address_set', ref: null, payload: { address } });
    });
  }

  /**
   * Registers the withdrawal address. The very first address may take effect immediately only
   * while no address exists and the active mode is paper; every other change is pending for the
   * timelock (24 h by default) and alerts the owner.
   */
  async setWithdrawAddress(address: string, actor: AuditActor = 'owner'): Promise<{ status: 'active' | 'pending'; address: string; effectiveAt: Date }> {
    if (!isValidAddress(address)) throw new RiskError('invalid address');
    return this.run(async (tx) => {
      const st = (await tx.client.query<{ active_mode: TradingMode; withdraw_address: string | null; pending_withdraw_address: string | null }>(
        'SELECT active_mode, withdraw_address, pending_withdraw_address FROM settings WHERE id = 1 FOR UPDATE',
      )).rows[0]!;
      if (st.withdraw_address === address && st.pending_withdraw_address === null) return { status: 'active' as const, address, effectiveAt: tx.now };
      const immediate = st.withdraw_address === null && st.pending_withdraw_address === null && st.active_mode === 'paper';
      if (immediate) {
        await tx.client.query('UPDATE settings SET withdraw_address = $1, updated_at = $2 WHERE id = 1', [address, tx.now]);
      } else {
        const effective = new Date(tx.now.getTime() + this.cfg.withdrawTimelockMs);
        await tx.client.query(
          'UPDATE settings SET pending_withdraw_address = $1, pending_withdraw_effective_at = $2, updated_at = $3 WHERE id = 1',
          [address, effective, tx.now],
        );
      }
      const effectiveAt = immediate ? tx.now : new Date(tx.now.getTime() + this.cfg.withdrawTimelockMs);
      tx.events.push({ actor, type: 'withdraw_address_change_requested', ref: withdrawAddressRef(address), payload: { address, previous: st.withdraw_address, status: immediate ? 'active' : 'pending', effectiveAt: effectiveAt.toISOString() } });
      tx.alerts.push({
        kind: 'withdraw_address_change', severity: 'critical', mode: st.active_mode,
        title: immediate ? 'Withdrawal address set' : 'Withdrawal address change requested',
        body: immediate
          ? `Withdrawals may now go to ${address}.`
          : `Withdrawals will go to ${address} from ${effectiveAt.toISOString()} (UTC). If you did not request this, cancel it and contact the operator now.`,
      });
      return { status: immediate ? ('active' as const) : ('pending' as const), address, effectiveAt };
    });
  }

  /** Promotes a pending withdrawal address once its timelock has passed. Returns true if promoted. */
  async promotePendingWithdrawAddress(): Promise<boolean> {
    return this.run(async (tx) => this.promoteInTx(tx));
  }

  private async promoteInTx(tx: Tx): Promise<boolean> {
    const st = (await tx.client.query<{ active_mode: TradingMode; withdraw_address: string | null; pending_withdraw_address: string | null; pending_withdraw_effective_at: Date | null }>(
      'SELECT active_mode, withdraw_address, pending_withdraw_address, pending_withdraw_effective_at FROM settings WHERE id = 1 FOR UPDATE',
    )).rows[0]!;
    if (!st.pending_withdraw_address || !st.pending_withdraw_effective_at || st.pending_withdraw_effective_at.getTime() > tx.now.getTime()) return false;
    await tx.client.query(
      'UPDATE settings SET withdraw_address = pending_withdraw_address, pending_withdraw_address = NULL, pending_withdraw_effective_at = NULL, updated_at = $1 WHERE id = 1',
      [tx.now],
    );
    tx.events.push({ actor: 'risk', type: 'withdraw_address_activated', ref: withdrawAddressRef(st.pending_withdraw_address), payload: { address: st.pending_withdraw_address, previous: st.withdraw_address } });
    tx.alerts.push({ kind: 'withdraw_address_change', severity: 'critical', mode: st.active_mode, title: 'Withdrawal address changed', body: `Withdrawals now go to ${st.pending_withdraw_address}.` });
    return true;
  }

  async cancelPendingWithdrawAddress(actor: AuditActor = 'owner'): Promise<boolean> {
    return this.run(async (tx) => {
      const r = await tx.client.query<{ pending_withdraw_address: string | null }>(
        'SELECT pending_withdraw_address FROM settings WHERE id = 1 FOR UPDATE',
      );
      const pending = r.rows[0]?.pending_withdraw_address ?? null;
      if (!pending) return false;
      await tx.client.query('UPDATE settings SET pending_withdraw_address = NULL, pending_withdraw_effective_at = NULL, updated_at = $1 WHERE id = 1', [tx.now]);
      tx.events.push({ actor, type: 'withdraw_address_change_cancelled', ref: null, payload: { address: pending } });
      return true;
    });
  }

  /**
   * Withdraws from free cash to the active allowlisted address only. Paper mode books it at once.
   * Live mode places a withdrawal hold and returns a withdraw ticket bound to that destination;
   * book the confirmed transfer with recordWithdrawal (or release the hold on failure).
   */
  async requestWithdrawal(lamports: bigint, actor: AuditActor = 'owner'): Promise<WithdrawResult> {
    let amount: bigint;
    try {
      amount = assertLamports(lamports, 'lamports');
    } catch {
      return { ok: false, reason: 'invalid_amount' };
    }
    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      const promoted = await this.promoteInTx(tx);
      const st = (await tx.client.query<{ withdraw_address: string | null }>('SELECT withdraw_address FROM settings WHERE id = 1')).rows[0]!;
      const destination = st.withdraw_address;
      if (!destination) {
        this.event(tx, 'withdrawal_refused', null, { lamports: amount, reason: 'no_withdraw_address' }, actor);
        return { ok: false as const, reason: 'no_withdraw_address' };
      }
      // An address set without a timelock (allowed only for the first address while paper mode is
      // active) must not become a live destination before the timelock would have passed.
      if (this.tradingMode === 'live' && !promoted && !(await this.addressPassedTimelock(tx, destination))) {
        this.event(tx, 'withdrawal_refused', null, { lamports: amount, reason: 'withdraw_address_timelocked', destination }, actor);
        return { ok: false as const, reason: 'withdraw_address_timelocked' };
      }
      await this.expireStale(tx);
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const free = s.cash - this.presetOf(s).limits.feeReserveLamports - book.heldLamports;
      if (amount > free) {
        await this.saveState(tx, s);
        this.event(tx, 'withdrawal_refused', null, { lamports: amount, reason: 'insufficient_free_cash', freeCash: free }, actor);
        return { ok: false as const, reason: 'insufficient_free_cash' };
      }
      const id = randomUUID();
      this.rollDay(tx, s, s.cash + book.inPositionsLamports);
      if (this.tradingMode === 'paper') {
        s.cash -= amount;
        s.sod = s.sod > amount ? s.sod - amount : 0n;
        s.peak = s.peak > amount ? s.peak - amount : 0n;
        await this.ledger(tx, 'withdraw', -amount, id, `withdrawal to ${destination}`);
        await this.saveState(tx, s);
        this.event(tx, 'withdrawal_booked', id, { lamports: amount, destination }, actor);
        tx.alerts.push({ kind: 'withdrawal', severity: 'info', mode: this.tradingMode, title: 'Paper withdrawal booked', body: `${amount} lamports to ${destination}.` });
        return { ok: true as const, withdrawalId: id, lamports: amount, destination, ticket: null };
      }
      const expiresAt = new Date(tx.now.getTime() + this.cfg.withdrawTicketTtlMs);
      const holdExpiresAt = new Date(expiresAt.getTime() + this.holdGraceMs());
      await tx.client.query(
        `INSERT INTO reservations (id, mode, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'held', $7, $8)`,
        [id, this.tradingMode, `withdraw:${id}`, WITHDRAWAL_SLEEVE, destination, amount.toString(), tx.now, holdExpiresAt],
      );
      await this.saveState(tx, s);
      const ticket = signTicket({
        v: 1, reservationId: id, intent: 'withdraw', mint: null, maxLamports: amount.toString(), maxTipLamports: '0',
        destination, issuedAt: tx.now.getTime(), expiresAt: expiresAt.getTime(),
      }, this.ticketSecret!);
      this.event(tx, 'withdrawal_authorized', id, { lamports: amount, destination, expiresAt: expiresAt.toISOString() }, actor);
      tx.alerts.push({ kind: 'withdrawal', severity: 'warning', mode: this.tradingMode, title: 'Withdrawal authorized', body: `${amount} lamports to ${destination}.` });
      return { ok: true as const, withdrawalId: id, lamports: amount, destination, ticket };
    });
  }

  /**
   * True when `address` became the active withdrawal address through the timelock, or was set
   * immediately at least one timelock period ago. Unknown provenance fails closed.
   */
  private async addressPassedTimelock(tx: Tx, address: string): Promise<boolean> {
    const r = (await tx.client.query<{ type: string; at: Date }>(
      `SELECT type, at FROM audit_events
        WHERE ref = $1
          AND (type = 'withdraw_address_activated' OR (type = 'withdraw_address_change_requested' AND payload->>'status' = 'active'))
        ORDER BY seq DESC LIMIT 1`,
      [withdrawAddressRef(address)],
    )).rows[0];
    if (!r) return false;
    if (r.type === 'withdraw_address_activated') return true;
    return tx.now.getTime() - r.at.getTime() >= this.cfg.withdrawTimelockMs;
  }

  /** Live mode: books a confirmed withdrawal transfer against its hold. */
  async recordWithdrawal(withdrawalId: string, lamportsSent: bigint, feeLamports: bigint, signature: string | null): Promise<void> {
    if (typeof withdrawalId !== 'string' || !UUID.test(withdrawalId)) throw new RiskError('invalid withdrawalId');
    const sent = assertLamports(lamportsSent, 'lamportsSent');
    const fee = assertLamports(feeLamports, 'feeLamports', true);
    await this.run(async (tx) => {
      const s = await this.lockState(tx);
      const r = (await tx.client.query<ReservationRow>(
        'SELECT id, idempotency_key, sleeve, mint, lamports, status, created_at, expires_at FROM reservations WHERE id = $1 AND mode = $2 FOR UPDATE',
        [withdrawalId, this.tradingMode],
      )).rows[0];
      if (!r || r.sleeve !== WITHDRAWAL_SLEEVE) throw new RiskError('unknown withdrawal');
      if (r.status === 'filled') return;
      if (sent > toBig(r.lamports)) throw new RiskError('withdrawal exceeds the authorized amount');
      if (sent + fee > s.cash) throw new RiskError('withdrawal exceeds booked cash');
      s.cash -= sent + fee;
      s.sod = s.sod > sent ? s.sod - sent : 0n;
      s.peak = s.peak > sent ? s.peak - sent : 0n;
      await this.ledger(tx, 'withdraw', -sent, r.id, `withdrawal to ${r.mint}`);
      await this.ledger(tx, 'fee', -fee, r.id, 'withdrawal fee');
      await tx.client.query(`UPDATE reservations SET status = 'filled', settled_at = $2 WHERE id = $1`, [r.id, tx.now]);
      await this.saveState(tx, s);
      this.event(tx, 'withdrawal_booked', r.id, { lamports: sent, feeLamports: fee, destination: r.mint, signature });
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------------------------

  /**
   * Compares the books with the chain. Live: the wallet's SOL balance must equal booked cash within
   * the tolerance. Paper skips the chain comparison. Both check that the ledger sums to cash.
   * Any unexplained mismatch halts with reconciliation_mismatch and is recorded in
   * reconciliation_runs. Token balances, if a fetcher is given, are reported but not enforced.
   */
  async reconcile(
    fetchChainLamports?: () => Promise<bigint>,
    opts: { fetchTokenBalances?: (mints: string[]) => Promise<Map<string, bigint>> } = {},
  ): Promise<ReconcileResult> {
    const live = this.tradingMode === 'live';
    if (live && !fetchChainLamports) throw new RiskError('live reconciliation needs a chain balance fetcher');

    let chain: bigint | null = null;
    let tokenReport: Array<{ mint: string; booked: string; chain: string | null }> | null = null;
    let snapshotBefore: string | null = null;
    if (live) {
      snapshotBefore = await this.ledgerSnapshot(this.pool);
      try {
        const v = await fetchChainLamports!();
        if (typeof v !== 'bigint' || v < 0n) throw new Error('chain balance is not a non-negative bigint');
        chain = v;
        this.reconcileFetchFailures = 0;
      } catch (err) {
        this.reconcileFetchFailures++;
        const reason = `chain balance fetch failed (${err instanceof Error ? err.message.slice(0, 120) : 'unknown'})`;
        if (this.reconcileFetchFailures >= this.cfg.reconcileMaxFetchFailures) {
          await this.halt('rpc_errors', `${reason}; ${this.reconcileFetchFailures} consecutive failures`);
        }
        return { status: 'error', reason };
      }
    }
    if (opts.fetchTokenBalances) {
      const pos = await this.openPositions();
      const byMint = new Map<string, bigint>();
      for (const p of pos) byMint.set(p.mint, (byMint.get(p.mint) ?? 0n) + p.tokenAmount);
      try {
        const onChain = await opts.fetchTokenBalances([...byMint.keys()]);
        tokenReport = [...byMint.entries()].map(([mint, booked]) => ({ mint, booked: booked.toString(), chain: onChain.get(mint)?.toString() ?? null }));
      } catch {
        tokenReport = null;
      }
    }

    return this.run(async (tx) => {
      const s = await this.lockState(tx);
      if (live && (await this.ledgerSnapshot(tx.client)) !== snapshotBefore) {
        return { status: 'deferred' as const, reason: 'ledger changed during the chain fetch' };
      }
      const sumRes = await tx.client.query<{ total: string }>('SELECT coalesce(sum(lamports), 0)::text AS total FROM ledger_entries WHERE mode = $1', [this.tradingMode]);
      const ledgerSum = toBig(sumRes.rows[0]!.total);
      const book = await loadBookTotals(tx.client, this.tradingMode);
      const detail: Record<string, unknown> = {
        ledgerSum: ledgerSum.toString(), cash: s.cash.toString(), held: book.heldLamports.toString(),
        openPositions: book.openCount, closingPositions: book.closingCount, costBasis: book.costBasisLamports.toString(),
        tokens: tokenReport,
      };
      const problems: string[] = [];
      if (ledgerSum !== s.cash) problems.push(`ledger sum ${ledgerSum} != cash ${s.cash}`);
      if (book.heldLamports > s.cash) problems.push(`held reservations ${book.heldLamports} exceed cash ${s.cash}`);
      let diff = ledgerSum - s.cash;
      if (live && chain !== null) {
        diff = chain - s.cash;
        const abs = diff < 0n ? -diff : diff;
        detail.chain = chain.toString();
        if (abs > this.cfg.reconcileToleranceLamports && problems.length === 0) {
          const inflightBuy = diff < 0n && book.heldLamports > 0n && -diff <= book.heldLamports;
          const inflightSell = diff > 0n && book.closingCount > 0;
          if ((inflightBuy || inflightSell) && this.reconcileDeferrals < this.cfg.reconcileMaxDeferrals) {
            this.reconcileDeferrals++;
            return { status: 'deferred' as const, reason: inflightBuy ? 'pending buy may explain the difference' : 'pending sell may explain the difference' };
          }
          problems.push(`chain ${chain} != booked cash ${s.cash} (diff ${diff})`);
        }
      }
      const ok = problems.length === 0;
      if (ok) this.reconcileDeferrals = 0;
      detail.problems = problems;
      await tx.client.query(
        'INSERT INTO reconciliation_runs (mode, at, ledger_lamports, chain_lamports, diff_lamports, ok, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)',
        [this.tradingMode, tx.now, s.cash.toString(), chain === null ? null : chain.toString(), diff.toString(), ok, JSON.stringify(detail)],
      );
      if (!ok) {
        this.applyHalt(tx, s, 'reconciliation_mismatch', problems.join('; '));
        await this.saveState(tx, s);
        this.event(tx, 'reconciliation_failed', null, detail);
        return { status: 'mismatch' as const, ledgerLamports: s.cash, chainLamports: chain, diffLamports: diff, detail: problems.join('; ') };
      }
      return { status: 'ok' as const, ledgerLamports: s.cash, chainLamports: chain, diffLamports: diff };
    });
  }

  private async ledgerSnapshot(q: pg.Pool | pg.PoolClient): Promise<string> {
    const r = await q.query<{ last_id: string | null; cash: string }>(
      `SELECT (SELECT max(id)::text FROM ledger_entries WHERE mode = $1) AS last_id, (SELECT cash_lamports::text FROM pool_state WHERE mode = $1) AS cash`,
      [this.tradingMode],
    );
    return `${r.rows[0]?.last_id ?? '0'}:${r.rows[0]?.cash ?? '0'}`;
  }

  // ---------------------------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------------------------

  /** Builds the UTC day summary and sends it through the alerter. */
  async dailySummary(date?: string): Promise<DailySummary> {
    const day = date ?? utcDate(this.clock.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RiskError('invalid date');
    const st = (await this.pool.query<{ engine_state: string; halt_reason: string | null; cash_lamports: string; sod_equity_lamports: string; sod_date: string | null }>(
      `SELECT engine_state, halt_reason, cash_lamports, sod_equity_lamports, to_char(sod_date, 'YYYY-MM-DD') AS sod_date FROM pool_state WHERE mode = $1`,
      [this.tradingMode],
    )).rows[0]!;
    const book = await loadBookTotals(this.pool, this.tradingMode);
    const equity = toBig(st.cash_lamports) + book.inPositionsLamports;
    const trades = (await this.pool.query<{ n: string; wins: string; realized: string }>(
      `SELECT count(*)::text AS n, count(*) FILTER (WHERE realized_pnl_lamports > 0)::text AS wins, coalesce(sum(realized_pnl_lamports), 0)::text AS realized
         FROM positions WHERE mode = $1 AND status = 'closed' AND closed_at >= (($2::date)::timestamp AT TIME ZONE 'UTC') AND closed_at < ((($2::date) + 1)::timestamp AT TIME ZONE 'UTC')`,
      [this.tradingMode, day],
    )).rows[0]!;
    const sod = st.sod_date === day ? toBig(st.sod_equity_lamports) : equity;
    const summary: DailySummary = {
      mode: this.tradingMode, date: day, equityLamports: equity, startOfDayEquityLamports: sod, netPnlLamports: equity - sod,
      realizedPnlLamports: toBig(trades.realized), trades: Number(trades.n), wins: Number(trades.wins), solUsd: this.solUsd(),
      engineState: st.engine_state, haltReason: st.halt_reason,
    };
    this.alerter.dailySummary(summary).catch(() => undefined);
    return summary;
  }
}
