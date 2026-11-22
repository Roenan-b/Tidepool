/**
 * Fixture data for DEMO_MODE previews. Nothing here touches an engine, a database or a chain.
 * Token symbols and addresses are fictional. Values drift slowly with time so polling looks alive.
 */
import { createHash } from 'node:crypto';
import type { AuditEventDto, CandidateDto, MetricsDto, PositionDto, StatusDto } from '@tidepool/core';
import type { SignalDto } from './labels.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Deterministic fake base58 address derived from a label. Not a real wallet or mint. */
export function fakeAddress(label: string, length = 44): string {
  const digest = createHash('sha256').update(`tidepool-demo:${label}`).digest();
  let out = '';
  for (let i = 0; i < length; i++) out += B58[digest[i % digest.length]! % 58];
  return out;
}

function fakeHash(label: string): string {
  return createHash('sha256').update(`tidepool-demo-hash:${label}`).digest('hex');
}

export const DEMO_DEPOSIT_ADDRESS = fakeAddress('deposit');
const WITHDRAW_ADDRESS = fakeAddress('withdraw');
const PENDING_WITHDRAW_ADDRESS = fakeAddress('withdraw-next');

const SYMBOLS = ['PUDDLE', 'KRILL', 'BRINE', 'GULLY', 'MOSSY', 'GLOOP', 'RIPTIDE', 'BARNACLE', 'SHOAL', 'NAUTI', 'CORALZ', 'SEAFOAM'];

function wave(now: number, periodMs: number, amplitude: number, phase = 0): number {
  return Math.sin((now / periodMs) * 2 * Math.PI + phase) * amplitude;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sol(n: number): bigint {
  return BigInt(Math.round(n * 1e9));
}

export function demoStatus(now = Date.now()): StatusDto {
  const solUsd = Math.round((187.4 + wave(now, 600_000, 1.8)) * 100) / 100;
  const inPositions = sol(1.62 + wave(now, 90_000, 0.03));
  const reserved = sol(0.05);
  const feeReserve = 100_000_000n;
  const cash = sol(8.61);
  const net = sol(-0.214 + wave(now, 120_000, 0.012, 1));
  return {
    mode: 'paper',
    liveTradingAllowed: false,
    state: 'running',
    haltReason: null,
    preset: 'balanced',
    solUsd,
    pool: {
      equityLamports: (cash + reserved + inPositions + feeReserve).toString(),
      cashLamports: cash.toString(),
      reservedLamports: reserved.toString(),
      inPositionsLamports: inPositions.toString(),
      feeReserveLamports: feeReserve.toString(),
    },
    today: {
      date: iso(now).slice(0, 10),
      netPnlLamports: net.toString(),
      lossLimitLamports: sol(0.8).toString(),
      trades: 23,
      wins: 13,
      stretchTargetUsd: 200,
    },
    wallet: {
      depositAddress: DEMO_DEPOSIT_ADDRESS,
      withdrawAddress: WITHDRAW_ADDRESS,
      pendingWithdrawAddress: PENDING_WITHDRAW_ADDRESS,
      pendingWithdrawEffectiveAt: iso(Math.ceil(now / 3600_000) * 3600_000 + 19 * 3600_000),
    },
    updatedAt: iso(now),
  };
}

export function demoPositions(now = Date.now(), status: 'open' | 'closed' | 'all' = 'all'): PositionDto[] {
  const out: PositionDto[] = [];
  for (let i = 0; i < 3; i++) {
    const entry = sol(0.5 + i * 0.03);
    const pnl = sol(wave(now, 45_000 + i * 7000, 0.02 + i * 0.01, i));
    out.push({
      id: `demo-pos-open-${i}`,
      mint: fakeAddress(`mint-${SYMBOLS[i]}`),
      symbol: SYMBOLS[i]!,
      strategy: 'momentum-v1',
      mode: 'paper',
      status: 'open',
      entryLamports: entry.toString(),
      markLamports: (entry + pnl).toString(),
      unrealizedPnlLamports: pnl.toString(),
      realizedPnlLamports: null,
      openedAt: iso(now - (i + 1) * 4 * 60_000),
      closedAt: null,
      exitReason: null,
    });
  }
  const reasons = ['take_profit', 'stop_loss', 'time_stop', 'take_profit', 'stop_loss', 'take_profit'];
  const pnls = [0.071, -0.041, 0.006, 0.064, -0.044, 0.058];
  for (let i = 0; i < 6; i++) {
    const entry = sol(0.5);
    const realized = sol(pnls[i]!);
    const closedAt = now - (i + 1) * 23 * 60_000;
    out.push({
      id: `demo-pos-closed-${i}`,
      mint: fakeAddress(`mint-${SYMBOLS[i + 3]}`),
      symbol: SYMBOLS[i + 3]!,
      strategy: 'momentum-v1',
      mode: 'paper',
      status: 'closed',
      entryLamports: entry.toString(),
      markLamports: null,
      unrealizedPnlLamports: null,
      realizedPnlLamports: realized.toString(),
      openedAt: iso(closedAt - 11 * 60_000),
      closedAt: iso(closedAt),
      exitReason: reasons[i]!,
    });
  }
  return status === 'all' ? out : out.filter((p) => (status === 'open' ? p.status !== 'closed' : p.status === 'closed'));
}

export function demoCandidates(now = Date.now()): CandidateDto[] {
  const vetoes: Array<string | null> = [null, null, null, 'top 10 holders own 58% of supply', null, 'freeze authority not revoked', null, 'liquidity below $20,000'];
  return SYMBOLS.slice(0, 8).map((symbol, i) => {
    const score = Math.round((88 - i * 5.5 + wave(now, 30_000, 2, i)) * 10) / 10;
    return {
      mint: fakeAddress(`mint-${symbol}`),
      symbol,
      score,
      reasons: [
        `volume trend ${(2.4 - i * 0.2).toFixed(1)}x vs 30m average`,
        `holders +${12 - i}% in 15m`,
        i % 2 === 0 ? 'curated accounts mentioning, sentiment positive' : 'DEX Screener trending, no paid boost',
      ],
      priceUsd: Number((0.00042 * (i + 1) * (1 + wave(now, 20_000, 0.02, i))).toFixed(8)),
      liquidityUsd: 145_000 - i * 16_000,
      mentionVelocity: Math.round((6.5 - i * 0.6) * 100) / 100,
      sentiment: Math.round((0.55 - i * 0.09) * 100) / 100,
      narrativeLabel: ['animal', 'ocean', 'community', null, 'ocean', 'celebrity', null, 'animal'][i] ?? null,
      observedAt: iso(now - (i + 1) * 9_000),
      expiresAt: iso(now + (10 - i) * 30_000),
      vetoReason: vetoes[i] ?? null,
    };
  });
}

const EVENT_TYPES: Array<{ actor: string; type: string; payload: (i: number) => Record<string, unknown> }> = [
  { actor: 'scout', type: 'candidate.scored', payload: (i) => ({ symbol: SYMBOLS[i % SYMBOLS.length], score: 70 + (i % 20), reasons: ['volume trend', 'holder growth'] }) },
  { actor: 'risk', type: 'reservation.approved', payload: (i) => ({ symbol: SYMBOLS[i % SYMBOLS.length], lamports: (sol(0.5)).toString(), sleeve: 'momentum-v1' }) },
  { actor: 'trader', type: 'order.filled', payload: (i) => ({ symbol: SYMBOLS[i % SYMBOLS.length], lamportsSpent: sol(0.501).toString(), slippageBps: 42 + (i % 30), paper: true }) },
  { actor: 'risk', type: 'reservation.vetoed', payload: (i) => ({ symbol: SYMBOLS[(i + 3) % SYMBOLS.length], reason: 'top 10 holders above threshold' }) },
  { actor: 'trader', type: 'position.closed', payload: (i) => ({ symbol: SYMBOLS[i % SYMBOLS.length], exitReason: i % 3 === 0 ? 'stop_loss' : 'take_profit', realizedPnlLamports: sol(i % 3 === 0 ? -0.04 : 0.06).toString() }) },
  { actor: 'risk', type: 'reconciliation.ok', payload: () => ({ diffLamports: '0' }) },
];

const TOTAL_EVENTS = 240;

export function demoEvents(now = Date.now(), opts: { limit?: number; beforeSeq?: number } = {}): AuditEventDto[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const top = Math.min(opts.beforeSeq ? opts.beforeSeq - 1 : TOTAL_EVENTS, TOTAL_EVENTS);
  const out: AuditEventDto[] = [];
  for (let seq = top; seq >= 1 && out.length < limit; seq--) {
    const kind = EVENT_TYPES[seq % EVENT_TYPES.length]!;
    out.push({
      seq,
      at: iso(now - (TOTAL_EVENTS - seq) * 37_000),
      actor: kind.actor,
      type: kind.type,
      ref: kind.type.startsWith('reconciliation') ? null : `demo-ref-${seq}`,
      payload: kind.payload(seq),
      hash: fakeHash(String(seq)),
    });
  }
  return out;
}

export function demoMetrics(now = Date.now()): MetricsDto {
  return {
    latencyMs: {
      signalToSubmit: {
        p50: Math.round(410 + wave(now, 60_000, 25)),
        p95: Math.round(980 + wave(now, 60_000, 60, 1)),
        p99: Math.round(1650 + wave(now, 60_000, 90, 2)),
      },
    },
    landingRate: Math.round((0.93 + wave(now, 120_000, 0.02)) * 1000) / 1000,
    rpc: { healthy: true, lastOkAt: iso(now - 1200), errorRate: 0.004 },
    dataFreshnessSeconds: { helius: 1.2, dexscreener: 8.5, jupiter: 2.1, lunarcrush: 74, x: 212, narrative: null },
    reconciliation: { lastRunAt: iso(now - 14_000), ok: true, diffLamports: '0' },
    auditChainValid: true,
    tradesLast24h: 41,
  };
}

export function demoSignals(now = Date.now(), limit = 60): SignalDto[] {
  const sources = ['helius', 'dexscreener', 'x', 'lunarcrush'];
  const kinds: Record<string, string[]> = {
    helius: ['pool.created', 'holder.spike'],
    dexscreener: ['pair.trending', 'volume.surge'],
    x: ['mention.burst'],
    lunarcrush: ['social.score'],
  };
  const out: SignalDto[] = [];
  const n = Math.min(Math.max(limit, 1), 200);
  const base = Math.floor(now / 4000);
  for (let i = 0; i < n; i++) {
    const id = base - i;
    const source = sources[Math.abs(id) % sources.length]!;
    const kindList = kinds[source]!;
    const symbol = SYMBOLS[Math.abs(id * 7) % SYMBOLS.length]!;
    out.push({
      id: String(id),
      source,
      mint: fakeAddress(`mint-${symbol}`),
      kind: kindList[Math.abs(id) % kindList.length]!,
      observedAt: iso(id * 4000),
      payload: { symbol, value: Math.round(((Math.abs(id) % 97) / 9.7) * 100) / 100 },
    });
  }
  return out;
}
