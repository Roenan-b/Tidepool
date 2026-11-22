/**
 * In-memory RiskOfficer for the backtest (and tests). Enforces the same preset limits as the real Risk Officer:
 * per-position cap, max open positions, per-token exposure, share of liquidity, fee reserve, the daily loss limit
 * (halts new entries for the rest of the UTC day) and the drawdown limit (halts entries for the rest of the run).
 * It is a model of the real ledger, not a replacement: the production Risk Officer lives in risk/.
 */
import { bpsOf, type HaltReason, type Preset, type TradingMode } from '@tidepool/core';
import type { Clock, ExitReport, FillReport, OpenPositionView, ReservationDecision, ReservationRequest, RiskOfficer } from '../contracts.js';

interface Res { id: string; key: string; mint: string; lamports: bigint; status: 'held' | 'filled' | 'released'; expiresAt: Date }

export interface ClosedTrade {
  positionId: string; mint: string; symbol: string; strategy: string;
  openedAt: Date; closedAt: Date; entryLamports: bigint; exitLamports: bigint;
  /** Fees burned by failed sell attempts on this position (booked via recordExitFailure). */
  exitFailureBurnLamports: bigint;
  /** exitLamports - entryLamports - exitFailureBurnLamports. */
  netLamports: bigint;
  reason: ExitReport['reason'];
}

interface Pos extends Omit<OpenPositionView, 'status' | 'markLamports'> { mark: bigint | null; status: 'open' | 'closing' | 'closed'; exitBurn: bigint }

export interface DayRecord { date: string; sodEquity: bigint; lossLimitHit: boolean }

export interface MemoryRiskOptions {
  preset: Preset;
  startingLamports: bigint;
  clock: Clock;
  newId?: () => string;
  /** Halt entries for the rest of the run when the drawdown limit is hit (default true). */
  haltOnDrawdown?: boolean;
  reservationTtlMs?: number;
}

export class MemoryRiskOfficer implements RiskOfficer {
  cash: bigint;
  readonly trades: ClosedTrade[] = [];
  readonly days = new Map<string, DayRecord>();
  readonly vetoes = new Map<string, number>();
  failedBuyBurnLamports = 0n;
  private readonly reservations = new Map<string, Res>();
  private readonly byKey = new Map<string, string>();
  private readonly positions = new Map<string, Pos>();
  private sodDate: string | null = null;
  private peak: bigint;
  private dayHalt: string | null = null;
  private fullHalt: { reason: HaltReason; detail: string } | null = null;
  private seq = 0;
  private readonly newId: () => string;

  constructor(private readonly o: MemoryRiskOptions) {
    if (o.startingLamports <= 0n) throw new RangeError('startingLamports must be positive');
    this.cash = o.startingLamports;
    this.peak = o.startingLamports;
    this.newId = o.newId ?? (() => `00000000-0000-4000-8000-${(++this.seq).toString(16).padStart(12, '0')}`);
  }

  mode(): TradingMode { return 'paper'; }

  equity(): bigint {
    let e = this.cash;
    for (const r of this.reservations.values()) if (r.status === 'held') e += r.lamports;
    for (const p of this.positions.values()) if (p.status !== 'closed') e += p.mark ?? p.entryLamports;
    return e;
  }

  haltState(): { dayHalted: boolean; fullHalt: string | null } {
    this.rollDay();
    return { dayHalted: this.dayHalt === this.sodDate, fullHalt: this.fullHalt?.reason ?? null };
  }

  /** Rolls the UTC day and re-evaluates loss limits. Call on every clock step. */
  rollDay(): void {
    const date = this.o.clock.now().toISOString().slice(0, 10);
    if (date !== this.sodDate) {
      this.sodDate = date;
      this.days.set(date, { date, sodEquity: this.equity(), lossLimitHit: false });
    }
  }

  private checkLimits(): void {
    this.rollDay();
    const eq = this.equity();
    if (eq > this.peak) this.peak = eq;
    const day = this.days.get(this.sodDate!)!;
    const limit = bpsOf(day.sodEquity, this.o.preset.limits.dailyLossLimitBps);
    if (eq - day.sodEquity <= -limit && limit > 0n) {
      day.lossLimitHit = true;
      this.dayHalt = this.sodDate;
    }
    const ddLimit = bpsOf(this.peak, this.o.preset.limits.maxDrawdownBps);
    if ((this.o.haltOnDrawdown ?? true) && this.peak - eq >= ddLimit && ddLimit > 0n && !this.fullHalt) {
      this.fullHalt = { reason: 'drawdown_limit', detail: `drawdown ${this.peak - eq} >= ${ddLimit}` };
    }
  }

  private veto(reason: string): ReservationDecision {
    const k = reason.split(':')[0]!;
    this.vetoes.set(k, (this.vetoes.get(k) ?? 0) + 1);
    return { approved: false, reason };
  }

  async canOpenNewPositions(): Promise<{ ok: boolean; reason: string | null }> {
    this.checkLimits();
    if (this.fullHalt) return { ok: false, reason: `halted: ${this.fullHalt.reason}` };
    if (this.dayHalt === this.sodDate) return { ok: false, reason: 'daily loss limit reached' };
    return { ok: true, reason: null };
  }

  async reserve(req: ReservationRequest): Promise<ReservationDecision> {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) {
      const r = this.reservations.get(existing)!;
      if (r.status === 'held') return { approved: true, reservationId: r.id, lamports: r.lamports, ticket: null, expiresAt: r.expiresAt };
      return this.veto('duplicate: idempotency key already used');
    }
    const gate = await this.canOpenNewPositions();
    if (!gate.ok) return this.veto(`halted: ${gate.reason}`);
    const L = this.o.preset.limits;
    if (req.lamports <= 0n) return this.veto('invalid: non-positive amount');
    const now = this.o.clock.now();
    if (Date.parse(req.candidate.expiresAt) <= now.getTime()) return this.veto('stale: candidate expired');
    const open = [...this.positions.values()].filter((p) => p.status !== 'closed');
    const held = [...this.reservations.values()].filter((r) => r.status === 'held');
    if (open.length + held.length >= L.maxOpenPositions) return this.veto('max_open: max open positions');
    const eq = this.equity();
    if (req.lamports > bpsOf(eq, L.maxPositionBps)) return this.veto('position_cap: above max position size');
    const exposure = open.filter((p) => p.mint === req.mint).reduce((a, p) => a + (p.mark ?? p.entryLamports), 0n)
      + held.filter((r) => r.mint === req.mint).reduce((a, r) => a + r.lamports, 0n);
    if (exposure + req.lamports > bpsOf(eq, L.maxPerTokenBps)) return this.veto('token_cap: per-token exposure');
    if (this.cash - L.feeReserveLamports < req.lamports) return this.veto('cash: insufficient cash above fee reserve');
    if (!(req.positionShareOfLiquidity <= this.o.preset.filters.maxPositionShareOfLiquidity)) return this.veto('liquidity: position too large for liquidity');
    const id = this.newId();
    const r: Res = { id, key: req.idempotencyKey, mint: req.mint, lamports: req.lamports, status: 'held', expiresAt: new Date(now.getTime() + (this.o.reservationTtlMs ?? 30_000)) };
    this.reservations.set(id, r);
    this.byKey.set(req.idempotencyKey, id);
    this.cash -= req.lamports;
    return { approved: true, reservationId: id, lamports: req.lamports, ticket: null, expiresAt: r.expiresAt };
  }

  async recordFill(f: FillReport): Promise<{ positionId: string }> {
    const r = this.reservations.get(f.reservationId);
    if (!r || r.status !== 'held') throw new Error(`reservation ${f.reservationId} not held`);
    if (f.lamportsSpent > r.lamports) throw new Error('fill exceeds reservation');
    r.status = 'filled';
    this.cash += r.lamports - f.lamportsSpent;
    const id = this.newId();
    this.positions.set(id, {
      id, mint: f.mint, symbol: f.symbol, strategy: f.strategy, entryLamports: f.lamportsSpent, tokenAmount: f.tokenAmount,
      entryPriceUsd: f.entryPriceUsd, openedAt: this.o.clock.now(), mark: null, status: 'open', exitBurn: 0n,
    });
    this.checkLimits();
    return { positionId: id };
  }

  async release(reservationId: string, _reason: string, burnedFeeLamports = 0n): Promise<void> {
    const r = this.reservations.get(reservationId);
    if (!r || r.status !== 'held') throw new Error(`reservation ${reservationId} not held`);
    if (burnedFeeLamports < 0n || burnedFeeLamports > r.lamports) throw new Error('invalid burned fee');
    r.status = 'released';
    this.cash += r.lamports - burnedFeeLamports;
    this.failedBuyBurnLamports += burnedFeeLamports;
    this.checkLimits();
  }

  async authorizeExit(positionId: string): Promise<{ ticket: null }> {
    const p = this.positions.get(positionId);
    if (!p || p.status === 'closed') throw new Error(`position ${positionId} not open`);
    return { ticket: null };
  }

  async recordExit(e: ExitReport): Promise<{ realizedPnlLamports: bigint }> {
    const p = this.positions.get(e.positionId);
    if (!p || p.status === 'closed') throw new Error(`position ${e.positionId} not open`);
    p.status = 'closed';
    this.cash += e.lamportsReceived;
    const net = e.lamportsReceived - p.entryLamports - p.exitBurn;
    this.trades.push({
      positionId: p.id, mint: p.mint, symbol: p.symbol, strategy: p.strategy, openedAt: p.openedAt, closedAt: this.o.clock.now(),
      entryLamports: p.entryLamports, exitLamports: e.lamportsReceived, exitFailureBurnLamports: p.exitBurn, netLamports: net, reason: e.reason,
    });
    this.checkLimits();
    return { realizedPnlLamports: net };
  }

  async recordExitFailure(positionId: string, burnedFeeLamports: bigint, _error: string): Promise<void> {
    const p = this.positions.get(positionId);
    if (!p || p.status === 'closed') throw new Error(`position ${positionId} not open`);
    if (burnedFeeLamports < 0n) throw new Error('invalid burned fee');
    p.exitBurn += burnedFeeLamports;
    this.cash -= burnedFeeLamports;
    this.checkLimits();
  }

  async markPositions(marks: Array<{ positionId: string; markLamports: bigint }>): Promise<void> {
    for (const m of marks) {
      const p = this.positions.get(m.positionId);
      if (p && p.status !== 'closed') p.mark = m.markLamports;
    }
    this.checkLimits();
  }

  async openPositions(): Promise<OpenPositionView[]> {
    return [...this.positions.values()].filter((p) => p.status !== 'closed')
      .map(({ mark, status, exitBurn: _b, ...v }) => ({ ...v, status: status === 'closing' ? 'closing' as const : 'open' as const, markLamports: mark }));
  }

  /** A kill-switch halt marks every open position closing, as the real Risk Officer does. */
  async halt(reason: HaltReason, detail: string): Promise<void> {
    this.fullHalt = { reason, detail };
    if (reason === 'kill_switch') for (const p of this.positions.values()) if (p.status === 'open') p.status = 'closing';
  }

  /** Force-books a position that could not be sold at end of data at zero value. */
  writeOff(positionId: string): void {
    const p = this.positions.get(positionId);
    if (!p || p.status === 'closed') return;
    p.status = 'closed';
    this.trades.push({
      positionId: p.id, mint: p.mint, symbol: p.symbol, strategy: p.strategy, openedAt: p.openedAt, closedAt: this.o.clock.now(),
      entryLamports: p.entryLamports, exitLamports: 0n, exitFailureBurnLamports: p.exitBurn, netLamports: -p.entryLamports - p.exitBurn, reason: 'manual',
    });
    this.checkLimits();
  }
}
