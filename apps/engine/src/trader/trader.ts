/**
 * Trader: deterministic execution of momentum-v1.
 *
 * Entry loop: top cached candidates -> strategy screen -> sizing -> broker quote -> Risk Officer reservation
 *   -> broker buy (inside the reservation) -> recordFill or release.
 * Monitor loop: mark open positions from sell quotes (net of estimated exit costs) -> exit rules
 *   -> authorizeExit -> broker sell with retries and capped slippage escalation -> recordExit.
 *
 * The entry path never calls a model or any slow network service; the only network calls are the broker's
 * quote and swap. Spending happens only after the Risk Officer approves a reservation, and in live mode only
 * with the ticket that reservation carries. Exits never depend on the halt state.
 */
import { randomUUID } from 'node:crypto';
import { getPreset, txOverheadLamports, type Candidate, type EngineState, type Preset, type PresetName } from '@tidepool/core';
import type { SignedTicket } from '@tidepool/core/ticket';
import { systemClock, type AuditLog, type Broker, type CandidateSource, type Clock, type EngineControl, type ExitReport, type FillReport, type OpenPositionView, type RiskOfficer } from '../contracts.js';
import {
  candidateLiquidityUsd, configVersion, decideEntry, decideExit, effectiveCostModel, entryIdempotencyKey, estimateExitNetLamports,
  liquidityUsdToLamports, momentumParams, screenCandidate, sizeEntry, type MomentumParams,
} from './strategy.js';
import { errorText, extraBuyOverheadOf, silentLogger, type AlertSink, type CostModelSelector, type Logger, type OrderRepository, type TraderAlert } from './types.js';

export interface SellRetryOptions {
  /** Attempts per exit cycle before alerting and backing off. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Slippage added per retry, bps. */
  slippageStepBps: number;
  /** Slippage never escalates above this, bps (unless the preset itself starts higher). */
  maxSlippageBps: number;
  /** After a full failed cycle, wait this long before the monitor tries again (kill switch ignores it). */
  stuckRetryMs: number;
}

export interface TraderOptions {
  entryTickMs?: number;
  monitorTickMs?: number;
  candidateLimit?: number;
  paramOverrides?: Partial<MomentumParams>;
  sell?: Partial<SellRetryOptions>;
  /** Consecutive failed marks before a position_unquotable alert. */
  unquotableAlertAfter?: number;
  /** Bounded memory of attempted idempotency keys. */
  usedKeyCacheSize?: number;
  /** When true, start() does not schedule timers; the caller drives runEntryTick/runMonitorTick (backtest, tests). */
  manualTicks?: boolean;
  /**
   * How long a mint stays blocked for new entries after a buy whose outcome is unknown or whose fill could not
   * be booked (the wallet may hold the token without a ledger position). Reconciliation settles it meanwhile.
   */
  unresolvedEntryBlockMs?: number;
  /** Bound on fills and exits that landed but are waiting to be booked with the Risk Officer. */
  maxPendingRecords?: number;
}

export interface TraderDeps {
  risk: RiskOfficer;
  broker: Broker;
  candidates: CandidateSource;
  orders: OrderRepository;
  /** Pool equity in lamports (cash + reserved + marked positions), from the Risk Officer's books. */
  equityLamports: () => Promise<bigint>;
  /** Latest SOL/USD, or null when unknown (entries are then skipped, exits continue). */
  solUsd: () => number | null | Promise<number | null>;
  /** Cost model for exit estimates and fixed transaction overhead per mint. */
  costModelFor: CostModelSelector;
  clock?: Clock;
  logger?: Logger;
  audit?: AuditLog;
  alert?: AlertSink;
  /** Called on start, pause, kill switch and stop so the lead can persist engine_state. */
  onStateChange?: (state: EngineState, info: { preset: PresetName | null; reason: string }) => void | Promise<void>;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export type EntryTickResult =
  | { status: 'skipped_overlap' | 'disabled' }
  | { status: 'blocked'; reason: string }
  | { status: 'error'; error: string }
  | { status: 'ran'; considered: number; entered: number; outcomes: Array<{ mint: string; outcome: string }> };

export type MonitorTickResult =
  | { status: 'skipped_overlap' }
  | { status: 'error'; error: string }
  | { status: 'ran'; marked: number; exitsStarted: number };

/** A sell that landed and still has to be booked with the Risk Officer. */
interface PendingExit { exit: ExitReport; burnToBook: bigint; slippageBps: number; attempt: number; alerted: boolean }

const DEFAULT_SELL: SellRetryOptions = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, slippageStepBps: 100, maxSlippageBps: 1_000, stuckRetryMs: 60_000 };
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Trader implements EngineControl {
  private readonly risk: RiskOfficer;
  private readonly broker: Broker;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly opts: Required<Omit<TraderOptions, 'paramOverrides' | 'sell'>> & { sell: SellRetryOptions; paramOverrides: Partial<MomentumParams> };

  private preset: Preset | null = null;
  private params: MomentumParams;
  private cfgVersion: string;
  private entriesEnabled = false;
  private monitorEnabled = false;
  private killed = false;
  private state: EngineState = 'stopped';

  private entryTimer: NodeJS.Timeout | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private entryTick: Promise<EntryTickResult> | null = null;
  private monitorTick: Promise<MonitorTickResult> | null = null;

  private readonly inFlightMints = new Set<string>();
  private readonly exiting = new Map<string, { mint: string; done: Promise<void> }>();
  private readonly stuckUntil = new Map<string, number>();
  private readonly unquotable = new Map<string, number>();
  private readonly usedKeys = new Set<string>();
  private readonly stopCooldown = new Map<string, number>();
  /** Mints blocked for entries until the given time (unknown buy outcome, unbooked fill). */
  private readonly unresolvedMints = new Map<string, number>();
  /** Landed buys whose recordFill failed, keyed by reservation id; retried on every monitor pass. */
  private readonly pendingFills = new Map<string, { fill: FillReport; cap: bigint }>();
  /** Landed sells not yet booked, keyed by position id; booked instead of selling again. */
  private readonly pendingExits = new Map<string, PendingExit>();
  /** Live sells with an unknown outcome: no new sell for the position until this time (also under the kill switch). */
  private readonly sellUnknownUntil = new Map<string, number>();

  constructor(private readonly deps: TraderDeps, options: TraderOptions = {}) {
    if (deps.risk.mode() !== deps.broker.mode) {
      throw new Error(`mode mismatch: risk officer is ${deps.risk.mode()}, broker is ${deps.broker.mode}`);
    }
    this.risk = deps.risk;
    this.broker = deps.broker;
    this.log = deps.logger ?? silentLogger;
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? randomUUID;
    this.sleep = deps.sleep ?? defaultSleep;
    const sell = { ...DEFAULT_SELL, ...options.sell };
    if (!(sell.maxAttempts >= 1)) throw new RangeError('sell.maxAttempts must be >= 1');
    this.opts = {
      entryTickMs: options.entryTickMs ?? 1_000,
      monitorTickMs: options.monitorTickMs ?? 2_000,
      candidateLimit: options.candidateLimit ?? 10,
      unquotableAlertAfter: options.unquotableAlertAfter ?? 3,
      usedKeyCacheSize: options.usedKeyCacheSize ?? 10_000,
      manualTicks: options.manualTicks ?? false,
      unresolvedEntryBlockMs: options.unresolvedEntryBlockMs ?? 60 * 60_000,
      maxPendingRecords: options.maxPendingRecords ?? 1_000,
      sell,
      paramOverrides: options.paramOverrides ?? {},
    };
    // Exits need parameters even if the engine was never started (kill switch after a restart).
    this.params = momentumParams(getPreset('balanced'), this.opts.paramOverrides);
    this.cfgVersion = configVersion('balanced', this.params);
  }

  // ---------- EngineControl ----------

  async start(presetName: PresetName): Promise<void> {
    const preset = getPreset(presetName);
    this.preset = preset;
    this.params = momentumParams(preset, this.opts.paramOverrides);
    this.cfgVersion = configVersion(preset.name, this.params);
    this.killed = false;
    this.entriesEnabled = true;
    this.monitorEnabled = true;
    this.scheduleEntry();
    this.scheduleMonitor();
    await this.setState('running', `started with preset ${preset.name}`);
    await this.auditEvent('trader_started', null, { preset: preset.name, configVersion: this.cfgVersion });
  }

  /** Stops new entries; open positions keep being monitored and exited by their rules. */
  async pause(): Promise<void> {
    this.entriesEnabled = false;
    this.clearEntryTimer();
    await this.setState('paused', 'entries paused; exits continue');
    await this.auditEvent('trader_paused', null, {});
  }

  /** Halts entries and sells every open position now. Works while halted and while stopped. */
  async killSwitch(): Promise<{ positionsClosing: number }> {
    this.entriesEnabled = false;
    this.killed = true;
    this.clearEntryTimer();
    try {
      await this.risk.halt('kill_switch', 'kill switch engaged');
    } catch (err) {
      this.log.error({ err: errorText(err) }, 'risk halt failed during kill switch; selling anyway');
    }
    let open: OpenPositionView[] = [];
    try {
      open = await this.risk.openPositions();
    } catch (err) {
      this.log.error({ err: errorText(err) }, 'could not list open positions during kill switch');
      await this.raise({ level: 'critical', code: 'kill_switch', message: 'kill switch could not list open positions' });
    }
    for (const p of open) this.launchExit(p, 'kill_switch', 'kill switch engaged');
    // Keep the monitor alive so any exit that fails is retried until it succeeds.
    this.monitorEnabled = true;
    this.scheduleMonitor();
    await this.setState('halted', 'kill switch');
    await this.auditEvent('kill_switch', null, { positionsClosing: open.length });
    await this.raise({ level: 'critical', code: 'kill_switch', message: `kill switch engaged; closing ${open.length} positions` });
    return { positionsClosing: open.length };
  }

  /**
   * Starts an exit for every open position with the given reason, without halting (operator "close all",
   * end of a backtest). Returns the number of positions being closed; await drain() for completion.
   */
  async closeAllPositions(reason: 'manual' | 'filter_change', detail: string): Promise<number> {
    const open = await this.risk.openPositions();
    for (const p of open) this.launchExit(p, reason, detail);
    return open.length;
  }

  /** Shutdown: stops both loops and waits for in-flight work. Does not sell anything. */
  async stop(): Promise<void> {
    this.entriesEnabled = false;
    this.monitorEnabled = false;
    this.clearEntryTimer();
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
    await this.drain();
    await this.setState('stopped', 'stopped');
  }

  /** Waits until no tick or exit is in flight. */
  async drain(): Promise<void> {
    for (;;) {
      const pending: Promise<unknown>[] = [...this.exiting.values()].map((e) => e.done);
      if (this.entryTick) pending.push(this.entryTick);
      if (this.monitorTick) pending.push(this.monitorTick);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  getState(): { state: EngineState; preset: PresetName | null; configVersion: string; exiting: number; killed: boolean } {
    return { state: this.state, preset: this.preset?.name ?? null, configVersion: this.cfgVersion, exiting: this.exiting.size, killed: this.killed };
  }

  // ---------- loops ----------

  private scheduleEntry(): void {
    if (this.opts.manualTicks || !this.entriesEnabled || this.entryTimer) return;
    this.entryTimer = setTimeout(() => {
      this.entryTimer = null;
      void this.runEntryTick().finally(() => this.scheduleEntry());
    }, this.opts.entryTickMs);
  }

  private scheduleMonitor(): void {
    if (this.opts.manualTicks || !this.monitorEnabled || this.monitorTimer) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      void this.runMonitorTick().finally(() => this.scheduleMonitor());
    }, this.opts.monitorTickMs);
  }

  private clearEntryTimer(): void {
    if (this.entryTimer) clearTimeout(this.entryTimer);
    this.entryTimer = null;
  }

  /** One entry pass. Never overlaps with itself: a call while a pass is running returns skipped_overlap. */
  runEntryTick(): Promise<EntryTickResult> {
    if (this.entryTick) return Promise.resolve({ status: 'skipped_overlap' });
    const p = this.entryPass().catch((err): EntryTickResult => {
      this.log.error({ err: errorText(err) }, 'entry tick failed');
      return { status: 'error', error: errorText(err) };
    }).finally(() => { this.entryTick = null; });
    this.entryTick = p;
    return p;
  }

  /** One monitor pass. Never overlaps with itself. Exits it starts run in the background (see drain()). */
  runMonitorTick(): Promise<MonitorTickResult> {
    if (this.monitorTick) return Promise.resolve({ status: 'skipped_overlap' });
    const p = this.monitorPass().catch((err): MonitorTickResult => {
      this.log.error({ err: errorText(err) }, 'monitor tick failed');
      return { status: 'error', error: errorText(err) };
    }).finally(() => { this.monitorTick = null; });
    this.monitorTick = p;
    return p;
  }

  // ---------- entries ----------

  private async entryPass(): Promise<EntryTickResult> {
    if (!this.entriesEnabled || !this.preset) return { status: 'disabled' };
    const gate = await this.risk.canOpenNewPositions();
    if (!gate.ok) return { status: 'blocked', reason: gate.reason ?? 'risk officer blocked entries' };
    const now = this.clock.now();
    const [open, candidates] = await Promise.all([this.risk.openPositions(), this.deps.candidates.topCandidates(this.opts.candidateLimit, now)]);
    const held = new Set<string>(open.map((p) => p.mint));
    for (const m of this.inFlightMints) held.add(m);
    for (const e of this.exiting.values()) held.add(e.mint);
    for (const f of this.pendingFills.values()) held.add(f.fill.mint);
    const nowMs = now.getTime();
    for (const [m, until] of this.stopCooldown) if (until <= nowMs) this.stopCooldown.delete(m);
    for (const [m, until] of this.unresolvedMints) {
      if (until > nowMs) held.add(m);
      else this.unresolvedMints.delete(m);
    }
    let slots = this.preset.limits.maxOpenPositions - open.length - this.inFlightMints.size - this.pendingFills.size;
    const outcomes: Array<{ mint: string; outcome: string }> = [];
    let entered = 0;
    for (const c of candidates) {
      if (!this.entriesEnabled) break;
      if (slots <= 0) { outcomes.push({ mint: c.mint, outcome: 'skip: max open positions' }); break; }
      const outcome = await this.tryEnter(c, held);
      outcomes.push({ mint: c.mint, outcome });
      if (outcome.startsWith('entered')) { entered += 1; slots -= 1; held.add(c.mint); }
    }
    return { status: 'ran', considered: candidates.length, entered, outcomes };
  }

  private rememberKey(key: string): void {
    if (this.usedKeys.size >= this.opts.usedKeyCacheSize) {
      const oldest = this.usedKeys.values().next().value;
      if (oldest !== undefined) this.usedKeys.delete(oldest);
    }
    this.usedKeys.add(key);
  }

  private async tryEnter(c: Candidate, held: Set<string>): Promise<string> {
    const p = this.params;
    if (typeof c.mint !== 'string' || !BASE58.test(c.mint)) return 'skip: invalid mint';
    if (held.has(c.mint)) return 'skip: already held or in flight';
    const cooldown = this.stopCooldown.get(c.mint);
    const nowMs = this.clock.now().getTime();
    if (cooldown !== undefined) {
      if (cooldown > nowMs) return 'skip: cooldown after stop-loss';
      this.stopCooldown.delete(c.mint);
    }
    const screen = screenCandidate(c, this.clock.now(), p);
    if (!screen.ok) return `skip: ${screen.reason}`;
    let key: string;
    try { key = entryIdempotencyKey(p.name, c.mint, c.observedAt); } catch { return 'skip: bad observedAt'; }
    if (this.usedKeys.has(key)) return 'skip: observation already attempted';

    const solUsd = await this.deps.solUsd();
    if (solUsd === null || !(solUsd > 0)) return 'skip: SOL price unknown';
    const equity = await this.deps.equityLamports();
    const sizing = { equityLamports: equity, liquidityLamports: liquidityUsdToLamports(candidateLiquidityUsd(c), solUsd) };
    const size = sizeEntry(sizing, p);
    if (!size.ok) return `skip: ${size.reason}`;
    const txOverhead = txOverheadLamports(effectiveCostModel(this.deps.costModelFor(c.mint), p.tipLamports));
    const overhead = txOverhead + extraBuyOverheadOf(this.broker);
    const quoteIn = size.lamports - overhead;
    if (quoteIn <= 0n) return 'skip: size does not cover transaction overhead';

    let quote;
    try {
      quote = await this.broker.quote(c.mint, 'buy', quoteIn);
    } catch (err) {
      return `skip: quote failed: ${errorText(err, 200)}`;
    }
    const decision = decideEntry({ candidate: c, now: this.clock.now(), params: p, sizing, quote });
    if (!decision.enter) return `skip: ${decision.reason}`;

    this.rememberKey(key);
    this.inFlightMints.add(c.mint);
    held.add(c.mint);
    try {
      return await this.reserveAndBuy(c, key, decision.lamports, decision.positionShareOfLiquidity, overhead, txOverhead, decision.reason);
    } finally {
      this.inFlightMints.delete(c.mint);
    }
  }

  /**
   * overhead: everything a buy may spend besides the swap input (tip, base fee, and for live brokers the
   * priority fee and token-account rent); txOverhead: the tip and base fee part, recorded as the order's fee.
   */
  private async reserveAndBuy(c: Candidate, key: string, size: bigint, share: number, overhead: bigint, txOverhead: bigint, why: string): Promise<string> {
    const p = this.params;
    const decision = await this.risk.reserve({ idempotencyKey: key, sleeve: p.name, mint: c.mint, lamports: size, candidate: c, positionShareOfLiquidity: share });
    if (!decision.approved) {
      this.log.info({ mint: c.mint, reason: decision.reason }, 'reservation vetoed');
      await this.auditEvent('entry_vetoed', c.mint, { reason: decision.reason, idempotencyKey: key });
      return `vetoed: ${decision.reason}`;
    }
    const { reservationId } = decision;
    // Never spend more than requested, even if the reservation is larger.
    const cap = decision.lamports < size ? decision.lamports : size;
    const lamportsIn = cap - overhead;
    const release = async (reason: string, burned: bigint) => {
      try {
        await this.risk.release(reservationId, reason, burned);
      } catch (err) {
        this.log.error({ reservationId, err: errorText(err) }, 'release failed');
        await this.raise({ level: 'critical', code: 'record_failed', message: `release of reservation ${reservationId} failed`, mint: c.mint });
      }
    };
    if (lamportsIn <= 0n) { await release('reservation too small for overhead', 0n); return 'released: reservation too small'; }
    if (decision.expiresAt.getTime() <= this.clock.now().getTime()) { await release('reservation expired before submit', 0n); return 'released: reservation expired'; }
    const ticketProblem = this.checkTicket(decision.ticket, 'buy', c.mint, lamportsIn);
    if (ticketProblem) { await release(ticketProblem, 0n); return `released: ${ticketProblem}`; }
    // The kill switch or a pause may have landed while the reservation was being approved.
    if (!this.entriesEnabled) { await release('entries disabled before submit', 0n); return 'released: entries disabled before submit'; }

    const orderId = this.newId();
    try {
      await this.deps.orders.create({
        id: orderId, mode: this.broker.mode, side: 'buy', mint: c.mint, reservationId, positionId: null,
        signalAt: new Date(c.observedAt), configVersion: this.cfgVersion, lamports: lamportsIn, tokenAmount: null,
      });
      await this.deps.orders.markSubmitted(orderId, this.clock.now());
    } catch (err) {
      // Fail closed: no untracked buy orders.
      this.log.error({ err: errorText(err), mint: c.mint }, 'order record failed; not buying');
      await release('order record failed', 0n);
      return 'released: order record failed';
    }
    await this.auditEvent('buy_submitted', c.mint, { orderId, reservationId, lamportsIn: lamportsIn.toString(), reason: why, configVersion: this.cfgVersion });
    if (!this.entriesEnabled) {
      await this.safeOrder(() => this.deps.orders.markFailed(orderId, { at: this.clock.now(), error: 'entries disabled before submit', feeLamports: 0n }));
      await release('entries disabled before submit', 0n);
      return 'released: entries disabled before submit';
    }

    let res: Awaited<ReturnType<Broker['buy']>>;
    try {
      res = await this.broker.buy({ mint: c.mint, lamportsIn, slippageBps: p.slippageBps, tipLamports: p.tipLamports, ticket: decision.ticket });
    } catch (err) {
      const msg = `outcome unknown: ${errorText(err, 300)}`;
      await this.safeOrder(() => this.deps.orders.markFailed(orderId, { at: this.clock.now(), error: msg, feeLamports: 0n }));
      if (this.broker.mode === 'paper') {
        await release(msg, 0n);
        return 'released: broker error';
      }
      // Live: the transaction may still land. Leave the reservation to expire and let reconciliation settle it.
      this.blockMint(c.mint);
      await this.raise({ level: 'critical', code: 'buy_outcome_unknown', message: `buy outcome unknown for ${c.mint}; reservation ${reservationId} left held`, mint: c.mint });
      return 'unknown: broker error';
    }

    if (!res.ok) {
      await this.safeOrder(() => this.deps.orders.markFailed(orderId, { at: this.clock.now(), error: res.error, feeLamports: res.burnedFeeLamports }));
      await release(`buy failed: ${res.error}`, res.burnedFeeLamports);
      await this.auditEvent('buy_failed', c.mint, { orderId, reservationId, error: res.error, burnedFeeLamports: res.burnedFeeLamports.toString() });
      return `released: buy failed: ${res.error}`;
    }

    await this.safeOrder(() => this.deps.orders.markLanded(orderId, { at: this.clock.now(), signature: res.signature, lamports: res.lamportsSpent, tokenAmount: res.tokenAmount, feeLamports: txOverhead }));
    if (res.lamportsSpent > cap) {
      await this.auditEvent('spend_above_reservation', c.mint, { orderId, reservationId, lamportsSpent: res.lamportsSpent.toString(), reservedLamports: cap.toString() });
      await this.raise({ level: 'critical', code: 'spend_above_reservation', message: `buy of ${c.mint} spent ${res.lamportsSpent} lamports, above the ${cap} reserved`, mint: c.mint });
    }
    if (res.tokenAmount <= 0n) {
      // SOL left the wallet but no tokens arrived: book the spend as a loss rather than open an unsellable position.
      this.blockMint(c.mint);
      await this.auditEvent('buy_no_tokens', c.mint, { orderId, reservationId, lamportsSpent: res.lamportsSpent.toString(), signature: res.signature });
      await this.raise({ level: 'critical', code: 'buy_no_tokens', message: `buy of ${c.mint} landed without tokens; ${res.lamportsSpent} lamports booked as lost`, mint: c.mint });
      await release('buy landed without tokens', res.lamportsSpent < cap ? res.lamportsSpent : cap);
      return 'released: buy landed without tokens';
    }
    const fill: FillReport = {
      reservationId, orderId, mint: c.mint, symbol: c.symbol, strategy: p.name,
      lamportsSpent: res.lamportsSpent, tokenAmount: res.tokenAmount, entryPriceUsd: c.priceUsd, signature: res.signature,
    };
    const positionId = await this.bookFill(fill);
    if (positionId !== null) return `entered: ${positionId}`;
    this.blockMint(c.mint);
    this.addPending(this.pendingFills, reservationId, { fill, cap });
    return 'entered: recordFill failed; will retry';
  }

  /** Books a landed buy with the Risk Officer. Returns null (after alerting) when it could not. */
  private async bookFill(fill: FillReport): Promise<string | null> {
    try {
      const { positionId } = await this.risk.recordFill(fill);
      await this.safeOrder(() => this.deps.orders.attachPosition(fill.orderId, positionId));
      await this.auditEvent('buy_filled', fill.mint, { orderId: fill.orderId, positionId, lamportsSpent: fill.lamportsSpent.toString(), tokenAmount: fill.tokenAmount.toString(), signature: fill.signature });
      return positionId;
    } catch (err) {
      await this.raise({ level: 'critical', code: 'record_failed', message: `buy landed but recordFill failed for ${fill.mint}: ${errorText(err, 200)}`, mint: fill.mint });
      return null;
    }
  }

  private blockMint(mint: string): void {
    if (this.unresolvedMints.size >= this.opts.usedKeyCacheSize) {
      const oldest = this.unresolvedMints.keys().next().value;
      if (oldest !== undefined) this.unresolvedMints.delete(oldest);
    }
    this.unresolvedMints.set(mint, this.clock.now().getTime() + this.opts.unresolvedEntryBlockMs);
  }

  private addPending<V>(map: Map<string, V>, key: string, value: V): void {
    if (!map.has(key) && map.size >= this.opts.maxPendingRecords) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) {
        map.delete(oldest);
        this.log.error({ dropped: oldest }, 'pending record queue full; oldest dropped, reconciliation must settle it');
      }
    }
    map.set(key, value);
  }

  /** Retries booking of buys that landed earlier but could not be recorded. */
  private async retryPendingFills(): Promise<void> {
    for (const [reservationId, { fill }] of [...this.pendingFills]) {
      try {
        const { positionId } = await this.risk.recordFill(fill);
        this.pendingFills.delete(reservationId);
        await this.safeOrder(() => this.deps.orders.attachPosition(fill.orderId, positionId));
        await this.auditEvent('buy_filled', fill.mint, { orderId: fill.orderId, positionId, lamportsSpent: fill.lamportsSpent.toString(), tokenAmount: fill.tokenAmount.toString(), signature: fill.signature, late: true });
      } catch (err) {
        this.log.warn({ reservationId, err: errorText(err, 200) }, 'recordFill retry failed');
      }
    }
  }

  /** Live mode requires a ticket that matches the intended transaction. Returns a problem description or null. */
  private checkTicket(t: SignedTicket | null, intent: 'buy' | 'sell', mint: string, lamportsIn: bigint | null): string | null {
    if (this.broker.mode !== 'live') return null;
    if (!t) return 'live mode without ticket';
    if (t.ticket.intent !== intent) return `ticket intent ${t.ticket.intent} != ${intent}`;
    if (t.ticket.mint !== mint) return 'ticket mint mismatch';
    if (!/^\d+$/.test(t.ticket.maxLamports) || !/^\d+$/.test(t.ticket.maxTipLamports)) return 'ticket amounts malformed';
    if (lamportsIn !== null && BigInt(t.ticket.maxLamports) < lamportsIn) return 'ticket amount below order';
    if (BigInt(t.ticket.maxTipLamports) < this.params.tipLamports) return 'ticket tip allowance below strategy tip';
    if (t.ticket.expiresAt <= this.clock.now().getTime()) return 'ticket expired';
    return null;
  }

  // ---------- monitoring and exits ----------

  private async monitorPass(): Promise<MonitorTickResult> {
    if (this.pendingFills.size > 0) await this.retryPendingFills();
    const open = await this.risk.openPositions();
    const now = this.clock.now();
    // Per-position state for positions that are no longer open (closed elsewhere, written off) is dropped.
    const openIds = new Set(open.map((p) => p.id));
    for (const m of [this.stuckUntil, this.unquotable, this.sellUnknownUntil, this.pendingExits] as Array<Map<string, unknown>>) {
      for (const id of m.keys()) if (!openIds.has(id) && !this.exiting.has(id)) m.delete(id);
    }
    const marks: Array<{ positionId: string; markLamports: bigint }> = [];
    const toExit: Array<{ pos: OpenPositionView; reason: ExitReport['reason']; detail: string }> = [];
    for (const pos of open) {
      if (this.exiting.has(pos.id)) continue;
      if (this.pendingExits.has(pos.id)) {
        // Already sold; only the booking is outstanding.
        toExit.push({ pos, reason: this.pendingExits.get(pos.id)!.exit.reason, detail: 'retry booking of a landed sell' });
        continue;
      }
      const net = await this.markOne(pos);
      if (net !== null) marks.push({ positionId: pos.id, markLamports: net > 0n ? net : 0n });
      // 'closing' means the Risk Officer (kill switch or operator) marked it for immediate sale.
      if (pos.status === 'closing') {
        const unknown = this.sellUnknownUntil.get(pos.id);
        if (unknown !== undefined && unknown > now.getTime()) continue;
        toExit.push({ pos, reason: this.killed ? 'kill_switch' : 'manual', detail: 'position marked closing by the risk officer' });
        continue;
      }
      const d = decideExit({ entryLamports: pos.entryLamports, openedAt: pos.openedAt, netExitLamports: net, now, params: this.params, killSwitch: this.killed });
      if (!d.exit) continue;
      const stuck = this.stuckUntil.get(pos.id);
      if (!this.killed && stuck !== undefined && stuck > now.getTime()) continue;
      const unknown = this.sellUnknownUntil.get(pos.id);
      if (unknown !== undefined && unknown > now.getTime()) continue;
      toExit.push({ pos, reason: d.reason, detail: d.detail });
    }
    if (marks.length > 0) {
      try {
        await this.risk.markPositions(marks);
      } catch (err) {
        this.log.error({ err: errorText(err) }, 'markPositions failed');
      }
    }
    for (const x of toExit) this.launchExit(x.pos, x.reason, x.detail);
    return { status: 'ran', marked: marks.length, exitsStarted: toExit.length };
  }

  private async markOne(pos: OpenPositionView): Promise<bigint | null> {
    try {
      const q = await this.broker.quote(pos.mint, 'sell', pos.tokenAmount);
      if (q.routeOk && q.priceLamportsPerUnit >= 0 && Number.isFinite(q.priceLamportsPerUnit)) {
        this.unquotable.delete(pos.id);
        return estimateExitNetLamports(pos.tokenAmount, q.priceLamportsPerUnit, effectiveCostModel(this.deps.costModelFor(pos.mint), this.params.tipLamports));
      }
    } catch (err) {
      this.log.warn({ mint: pos.mint, err: errorText(err, 200) }, 'sell quote failed');
    }
    const n = (this.unquotable.get(pos.id) ?? 0) + 1;
    this.unquotable.set(pos.id, n);
    if (n === this.opts.unquotableAlertAfter) {
      await this.raise({ level: 'warning', code: 'position_unquotable', message: `no sell quote for ${pos.symbol} after ${n} tries`, mint: pos.mint, positionId: pos.id });
    }
    return null;
  }

  private launchExit(pos: OpenPositionView, reason: ExitReport['reason'], detail: string): void {
    if (this.exiting.has(pos.id)) return;
    const done = this.exitPosition(pos, reason, detail)
      .catch(async (err) => {
        this.log.error({ positionId: pos.id, err: errorText(err) }, 'exit crashed');
        await this.raise({ level: 'critical', code: 'exit_failed', message: `exit of ${pos.symbol} crashed: ${errorText(err, 200)}`, positionId: pos.id, mint: pos.mint });
      })
      .finally(() => { this.exiting.delete(pos.id); });
    this.exiting.set(pos.id, { mint: pos.mint, done });
  }

  private async exitPosition(pos: OpenPositionView, reason: ExitReport['reason'], detail: string): Promise<void> {
    // A sell that already landed is only booked, never sold again (the tokens are gone).
    const pending = this.pendingExits.get(pos.id);
    if (pending) {
      await this.settleExit(pos, pending);
      return;
    }
    const unknownUntil = this.sellUnknownUntil.get(pos.id);
    if (unknownUntil !== undefined && unknownUntil > this.clock.now().getTime()) return;
    const p = this.params;
    const s = this.opts.sell;
    const overhead = txOverheadLamports(effectiveCostModel(this.deps.costModelFor(pos.mint), p.tipLamports));
    const ceiling = Math.max(s.maxSlippageBps, p.slippageBps);
    let burnedTotal = 0n;
    await this.auditEvent('exit_decision', pos.id, { mint: pos.mint, reason, detail, configVersion: this.cfgVersion });
    for (let attempt = 0; attempt < s.maxAttempts; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(s.baseDelayMs * 2 ** (attempt - 1), s.maxDelayMs));
      const slippageBps = Math.min(p.slippageBps + attempt * s.slippageStepBps, ceiling);
      let ticket: SignedTicket | null;
      try {
        // A fresh authorization per attempt: a ticket is single-use at the signer.
        ({ ticket } = await this.risk.authorizeExit(pos.id, reason));
      } catch (err) {
        this.log.warn({ positionId: pos.id, attempt, err: errorText(err, 200) }, 'authorizeExit failed');
        continue;
      }
      const problem = this.checkTicket(ticket, 'sell', pos.mint, null);
      if (problem) { this.log.warn({ positionId: pos.id, problem }, 'exit ticket rejected'); continue; }

      const orderId = this.newId();
      let recorded = true;
      try {
        await this.deps.orders.create({ id: orderId, mode: this.broker.mode, side: 'sell', mint: pos.mint, reservationId: null, positionId: pos.id, signalAt: null, configVersion: this.cfgVersion, lamports: null, tokenAmount: pos.tokenAmount });
        await this.deps.orders.markSubmitted(orderId, this.clock.now());
      } catch (err) {
        // Exits are never blocked by bookkeeping problems.
        recorded = false;
        this.log.error({ positionId: pos.id, err: errorText(err) }, 'sell order record failed; selling anyway');
      }

      let res: Awaited<ReturnType<Broker['sell']>>;
      try {
        res = await this.broker.sell({ mint: pos.mint, tokenAmount: pos.tokenAmount, slippageBps, tipLamports: p.tipLamports, ticket });
      } catch (err) {
        const error = `outcome unknown: ${errorText(err, 300)}`;
        if (recorded) await this.safeOrder(() => this.deps.orders.markFailed(orderId, { at: this.clock.now(), error, feeLamports: 0n }));
        if (this.broker.mode === 'live') {
          // The sell may still land. Selling again right away would at best burn fees on an empty token account,
          // so hold this position (kill switch included) and let reconciliation settle the balance.
          this.sellUnknownUntil.set(pos.id, this.clock.now().getTime() + s.stuckRetryMs);
          await this.auditEvent('sell_outcome_unknown', pos.id, { orderId, mint: pos.mint, reason, error });
          await this.raise({ level: 'critical', code: 'sell_outcome_unknown', message: `sell outcome unknown for ${pos.symbol}; holding further sells for ${Math.round(s.stuckRetryMs / 1000)}s, reconcile the wallet`, positionId: pos.id, mint: pos.mint });
          return;
        }
        this.log.warn({ positionId: pos.id, attempt, error }, 'paper sell threw');
        continue;
      }

      if (res.ok) {
        if (recorded) await this.safeOrder(() => this.deps.orders.markLanded(orderId, { at: this.clock.now(), signature: res.signature, lamports: res.lamportsReceived, tokenAmount: pos.tokenAmount, feeLamports: overhead }));
        this.stuckUntil.delete(pos.id);
        this.unquotable.delete(pos.id);
        this.sellUnknownUntil.delete(pos.id);
        // Proceeds below the transaction's own fees are booked as a fee burn and the exit at zero, so the
        // ledger moves by exactly what the wallet did and the exit record stays non-negative.
        const received = res.lamportsReceived;
        const state: PendingExit = {
          exit: { positionId: pos.id, orderId, lamportsReceived: received > 0n ? received : 0n, reason, signature: res.signature },
          burnToBook: received < 0n ? -received : 0n,
          slippageBps,
          attempt,
          alerted: false,
        };
        if (reason === 'stop_loss' && this.preset) {
          this.stopCooldown.set(pos.mint, this.clock.now().getTime() + this.preset.filters.cooldownAfterStopSeconds * 1000);
        }
        this.addPending(this.pendingExits, pos.id, state);
        await this.settleExit(pos, state, burnedTotal);
        return;
      }

      burnedTotal += res.burnedFeeLamports;
      try {
        await this.risk.recordExitFailure(pos.id, res.burnedFeeLamports, res.error);
      } catch (err) {
        await this.raise({ level: 'critical', code: 'record_failed', message: `recordExitFailure failed for ${pos.symbol}: ${errorText(err, 200)}`, positionId: pos.id, mint: pos.mint });
      }
      if (recorded) await this.safeOrder(() => this.deps.orders.markFailed(orderId, { at: this.clock.now(), error: res.error, feeLamports: res.burnedFeeLamports }));
      this.log.warn({ positionId: pos.id, attempt, slippageBps, error: res.error }, 'sell attempt failed');
    }
    this.stuckUntil.set(pos.id, this.clock.now().getTime() + s.stuckRetryMs);
    await this.auditEvent('exit_failed', pos.id, { mint: pos.mint, reason, attempts: s.maxAttempts, burnedFeeLamports: burnedTotal.toString() });
    await this.raise({ level: 'critical', code: 'exit_failed', message: `could not exit ${pos.symbol} after ${s.maxAttempts} attempts (${reason}); will retry`, positionId: pos.id, mint: pos.mint });
  }

  /**
   * Books a landed sell: first any proceeds shortfall as a fee burn, then the exit. On failure the state stays in
   * pendingExits and the next monitor pass retries the booking instead of selling again.
   */
  private async settleExit(pos: OpenPositionView, state: PendingExit, burnedOnRetries = 0n): Promise<void> {
    try {
      if (state.burnToBook > 0n) {
        await this.risk.recordExitFailure(pos.id, state.burnToBook, 'sell proceeds below transaction fees');
        state.burnToBook = 0n;
      }
      const { realizedPnlLamports } = await this.risk.recordExit(state.exit);
      this.pendingExits.delete(pos.id);
      await this.auditEvent('sell_filled', pos.id, {
        orderId: state.exit.orderId, reason: state.exit.reason, lamportsReceived: state.exit.lamportsReceived.toString(), burnedOnRetries: burnedOnRetries.toString(),
        realizedPnlLamports: realizedPnlLamports.toString(), attempt: state.attempt, slippageBps: state.slippageBps,
      });
    } catch (err) {
      if (state.alerted) { this.log.warn({ positionId: pos.id, err: errorText(err, 200) }, 'exit booking retry failed'); return; }
      state.alerted = true;
      await this.raise({ level: 'critical', code: 'record_failed', message: `sell landed but booking failed for ${pos.symbol}: ${errorText(err, 200)}; will retry booking, not the sale`, positionId: pos.id, mint: pos.mint });
    }
  }

  // ---------- helpers ----------

  private async safeOrder(fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch (err) { this.log.error({ err: errorText(err) }, 'order record update failed'); }
  }

  private async setState(state: EngineState, reason: string): Promise<void> {
    this.state = state;
    try { await this.deps.onStateChange?.(state, { preset: this.preset?.name ?? null, reason }); } catch (err) {
      this.log.error({ err: errorText(err) }, 'onStateChange callback failed');
    }
  }

  private async auditEvent(type: string, ref: string | null, payload: Record<string, unknown>): Promise<void> {
    if (!this.deps.audit) return;
    try { await this.deps.audit.append({ actor: 'trader', type, ref, payload }); } catch (err) {
      this.log.error({ type, err: errorText(err) }, 'audit append failed');
    }
  }

  private async raise(a: TraderAlert): Promise<void> {
    const fn = a.level === 'critical' ? this.log.error.bind(this.log) : this.log.warn.bind(this.log);
    fn({ alert: a.code, mint: a.mint, positionId: a.positionId }, a.message);
    try { await this.deps.alert?.(a); } catch (err) { this.log.error({ err: errorText(err) }, 'alert sink failed'); }
  }
}

/** Factory for main.ts. */
export function createTrader(deps: TraderDeps, options?: TraderOptions): Trader {
  return new Trader(deps, options);
}
