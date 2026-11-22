/**
 * Test support for the trader and backtest suites: candidate builders and in-memory fakes with call recording.
 * No test-runner imports, so it type-checks with the rest of the module.
 */
import type { Candidate, HaltReason, TradingMode } from '@tidepool/core';
import type { SignedTicket } from '@tidepool/core/ticket';
import type {
  Broker,
  CandidateSource,
  ExitReport,
  FillReport,
  OpenPositionView,
  ReservationDecision,
  ReservationRequest,
  RiskOfficer,
} from '../contracts.js';

export const MINT_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
export const MINT_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
export const MINT_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

export function makeCandidate(
  over: Partial<Candidate> & { liquidityUsd?: number } = {},
  now = new Date('2026-11-01T00:00:00Z'),
): Candidate {
  const liq = over.liquidityUsd ?? 200_000;
  const mint = over.mint ?? MINT_A;
  const { liquidityUsd: _l, ...rest } = over;
  return {
    mint,
    symbol: 'TEST',
    pairAddress: mint,
    score: 80,
    features: {
      liquidityUsd: liq,
      volume5mUsd: 10_000,
      volumeTrend: 1.5,
      priceChange5mPct: 5,
      holderCount: 1000,
      holderGrowth15m: 1.1,
      mentionVelocity: 2,
      sentiment: 0.3,
      narrativeLabel: null,
      narrativeScore: null,
      boosted: false,
    },
    safety: {
      mint,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      token2022Extensions: [],
      liquidityUsd: liq,
      top10HolderShare: 0.2,
      creatorFlagged: false,
      ageSeconds: 86_400,
      sellSimulationRatio: 0.97,
    },
    reasons: ['test'],
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    priceUsd: 0.001,
    ...rest,
  };
}

export function makeTicket(intent: 'buy' | 'sell', mint: string, maxLamports: bigint, expiresAt: number): SignedTicket {
  return {
    ticket: {
      v: 1,
      reservationId: 'r1',
      intent,
      mint,
      maxLamports: maxLamports.toString(),
      maxTipLamports: '1000000',
      destination: null,
      issuedAt: expiresAt - 30_000,
      expiresAt,
    },
    mac: 'a'.repeat(64),
  };
}

export class StaticCandidates implements CandidateSource {
  calls = 0;
  constructor(
    public list: Candidate[] = [],
    private readonly gate?: Promise<void>,
  ) {}
  async topCandidates(limit: number): Promise<Candidate[]> {
    this.calls += 1;
    if (this.gate) await this.gate;
    return this.list.slice(0, limit);
  }
}

/** RiskOfficer fake: records every call; approve/veto and halt are controlled by the test. */
export class FakeRisk implements RiskOfficer {
  calls: { fn: string; args: unknown[] }[] = [];
  approve = true;
  vetoReason = 'vetoed by test';
  canOpen = true;
  positions: OpenPositionView[] = [];
  ticketFor: ((req: ReservationRequest) => SignedTicket | null) | null = null;
  exitTicket: ((positionId: string) => SignedTicket | null) | null = null;
  /** Runs inside reserve() before it answers (to interleave a kill switch with an approval). */
  onReserve: (() => Promise<void>) | null = null;
  /** Number of upcoming recordFill / recordExit calls that throw (simulated database outage). */
  failRecordFill = 0;
  failRecordExit = 0;
  private seq = 0;
  constructor(
    private readonly tradingMode: TradingMode = 'paper',
    private readonly now: () => Date = () => new Date('2026-11-01T00:00:00Z'),
  ) {}

  private rec(fn: string, ...args: unknown[]) {
    this.calls.push({ fn, args });
  }
  count(fn: string): number {
    return this.calls.filter((c) => c.fn === fn).length;
  }
  argsOf<T = unknown>(fn: string): T[] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args[0] as T);
  }

  mode(): TradingMode {
    return this.tradingMode;
  }
  async canOpenNewPositions() {
    this.rec('canOpenNewPositions');
    return this.canOpen ? { ok: true, reason: null } : { ok: false, reason: 'halted' };
  }
  async reserve(req: ReservationRequest): Promise<ReservationDecision> {
    this.rec('reserve', req);
    if (this.onReserve) await this.onReserve();
    if (!this.approve) return { approved: false, reason: this.vetoReason };
    return {
      approved: true,
      reservationId: `res-${++this.seq}`,
      lamports: req.lamports,
      ticket: this.ticketFor ? this.ticketFor(req) : null,
      expiresAt: new Date(this.now().getTime() + 30_000),
    };
  }
  async recordFill(f: FillReport) {
    this.rec('recordFill', f);
    if (this.failRecordFill > 0) {
      this.failRecordFill -= 1;
      throw new Error('database unavailable');
    }
    const id = `pos-${++this.seq}`;
    this.positions.push({
      id,
      mint: f.mint,
      symbol: f.symbol,
      strategy: f.strategy,
      status: 'open',
      entryLamports: f.lamportsSpent,
      tokenAmount: f.tokenAmount,
      entryPriceUsd: f.entryPriceUsd,
      openedAt: this.now(),
      markLamports: null,
    });
    return { positionId: id };
  }
  async release(reservationId: string, reason: string, burned?: bigint) {
    this.rec('release', { reservationId, reason, burned });
  }
  async authorizeExit(positionId: string, reason: ExitReport['reason']) {
    this.rec('authorizeExit', { positionId, reason });
    return { ticket: this.exitTicket ? this.exitTicket(positionId) : null };
  }
  async recordExit(e: ExitReport) {
    this.rec('recordExit', e);
    if (this.failRecordExit > 0) {
      this.failRecordExit -= 1;
      throw new Error('database unavailable');
    }
    const p = this.positions.find((x) => x.id === e.positionId);
    this.positions = this.positions.filter((x) => x.id !== e.positionId);
    return { realizedPnlLamports: p ? e.lamportsReceived - p.entryLamports : 0n };
  }
  async recordExitFailure(positionId: string, burnedFeeLamports: bigint, error: string) {
    this.rec('recordExitFailure', { positionId, burnedFeeLamports, error });
  }
  async markPositions(marks: { positionId: string; markLamports: bigint }[]) {
    this.rec('markPositions', marks);
  }
  async openPositions() {
    this.rec('openPositions');
    return this.positions.map((p) => ({ ...p }));
  }
  /** Like the real Risk Officer, a kill-switch halt marks every open position closing. */
  async halt(reason: HaltReason, detail: string) {
    this.rec('halt', { reason, detail });
    this.canOpen = false;
    if (reason === 'kill_switch') this.positions = this.positions.map((p) => ({ ...p, status: 'closing' as const }));
  }
}

type BuyRes = Awaited<ReturnType<Broker['buy']>>;
type SellRes = Awaited<ReturnType<Broker['sell']>>;

/** Broker fake: fixed quote per mint, scripted buy and sell results. */
export class FakeBroker implements Broker {
  buys: Parameters<Broker['buy']>[0][] = [];
  sells: Parameters<Broker['sell']>[0][] = [];
  quotes: { mint: string; side: string; amount: bigint }[] = [];
  price = new Map<string, number>();
  impactPct = 0.5;
  routeOk = true;
  buyResult: BuyRes | ((a: Parameters<Broker['buy']>[0]) => BuyRes) | Error = {
    ok: true,
    lamportsSpent: 0n,
    tokenAmount: 1_000_000n,
    signature: null,
  };
  sellResults: (SellRes | Error)[] = [];
  defaultSell: SellRes = { ok: true, lamportsReceived: 1_000_000_000n, signature: null };
  constructor(readonly mode: TradingMode = 'paper') {}

  async quote(mint: string, side: 'buy' | 'sell', amount: bigint) {
    this.quotes.push({ mint, side, amount });
    return { priceLamportsPerUnit: this.price.get(mint) ?? 1, priceImpactPct: this.impactPct, routeOk: this.routeOk };
  }
  async buy(a: Parameters<Broker['buy']>[0]): Promise<BuyRes> {
    this.buys.push(a);
    const r = this.buyResult;
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(a);
    if (r.ok && r.lamportsSpent === 0n) return { ...r, lamportsSpent: a.lamportsIn + a.tipLamports + 5_000n };
    return r;
  }
  async sell(a: Parameters<Broker['sell']>[0]): Promise<SellRes> {
    this.sells.push(a);
    const r = this.sellResults.shift() ?? this.defaultSell;
    if (r instanceof Error) throw r;
    return r;
  }
}
