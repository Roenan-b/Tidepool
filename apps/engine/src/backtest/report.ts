/** Backtest report: metrics computed from the replay's ledger, plus JSON and markdown renderings. */
import { lamportsToSol, toJsonSafe, type PresetName } from '@tidepool/core';
import type { PaperCostTotals } from '../trader/paperBroker.js';
import type { MomentumParams } from '../trader/strategy.js';
import type { ClosedTrade, DayRecord } from './memoryRisk.js';

export const SYNTHETIC_LABEL = 'SYNTHETIC DATA: generated fixture, not market data. Results say nothing about real performance.';

export interface DailyRow {
  date: string;
  startEquityLamports: bigint;
  endEquityLamports: bigint;
  netLamports: bigint;
  trades: number;
  wins: number;
  lossLimitHit: boolean;
}

export interface BacktestReport {
  synthetic: boolean;
  label: string;
  preset: PresetName;
  configVersion: string;
  params: MomentumParams;
  seed: number;
  window: { from: string; to: string };
  startingEquityLamports: bigint;
  endingEquityLamports: bigint;
  summary: {
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgNetLamportsPerTrade: bigint | null;
    /** Sum of closed-trade nets (entry includes buy fees; exit is net of sell fees; failed-sell burns are subtracted per trade). */
    totalTradeNetLamports: bigint;
    /** Fees burned by buy transactions that failed (not part of any trade). */
    failedBuyBurnLamports: bigint;
    /** totalTradeNet - failedBuyBurn; equals ending - starting equity. */
    netAfterAllCostsLamports: bigint;
    maxDrawdownLamports: bigint;
    maxDrawdownPct: number;
    exitReasons: Record<string, number>;
    entries: { ticks: number; entered: number; vetoed: number; buyFailed: number; skipped: number };
    vetoes: Record<string, number>;
    writtenOffPositions: number;
  };
  costs: {
    venueFeeLamports: bigint;
    slippageLamports: bigint;
    priceImpactLamports: bigint;
    tipLamports: bigint;
    baseFeeLamports: bigint;
    failedTxBurnLamports: bigint;
    totalLamports: bigint;
    filledTransactions: number;
    failedTransactions: number;
  };
  daily: DailyRow[];
  lossLimitDayShare: number | null;
  vsSol: null | { solUsdStart: number; solUsdEnd: number; holdSolReturnPct: number; strategyUsdReturnPct: number; excessPct: number };
  trades: Array<{
    positionId: string; mint: string; symbol: string; openedAt: string; closedAt: string; holdSeconds: number;
    entryLamports: bigint; exitLamports: bigint; exitFailureBurnLamports: bigint; netLamports: bigint; reason: string;
  }>;
}

export interface BuildReportInput {
  synthetic: boolean;
  preset: PresetName;
  params: MomentumParams;
  configVersion: string;
  seed: number;
  from: number;
  to: number;
  startingLamports: bigint;
  endingLamports: bigint;
  trades: ClosedTrade[];
  days: Map<string, DayRecord>;
  equity: Array<{ at: number; lamports: bigint }>;
  costs: PaperCostTotals;
  failedBuyBurnLamports: bigint;
  entryStats: BacktestReport['summary']['entries'];
  vetoes: Record<string, number>;
  writtenOff: number;
  solUsdStart: number | null;
  solUsdEnd: number | null;
}

export function buildReport(i: BuildReportInput): BacktestReport {
  const trades = i.trades;
  const wins = trades.filter((t) => t.netLamports > 0n).length;
  const totalTradeNet = trades.reduce((a, t) => a + t.netLamports, 0n);

  let peak = i.equity[0]?.lamports ?? i.startingLamports;
  let maxDd = 0n;
  let maxDdPct = 0;
  for (const s of i.equity) {
    if (s.lamports > peak) peak = s.lamports;
    const dd = peak - s.lamports;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0n) maxDdPct = Math.max(maxDdPct, (Number(dd) / Number(peak)) * 100);
  }

  const lastByDay = new Map<string, bigint>();
  for (const s of i.equity) lastByDay.set(new Date(s.at).toISOString().slice(0, 10), s.lamports);
  const daily: DailyRow[] = [...i.days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
    const end = lastByDay.get(d.date) ?? d.sodEquity;
    const closed = trades.filter((t) => t.closedAt.toISOString().slice(0, 10) === d.date);
    return { date: d.date, startEquityLamports: d.sodEquity, endEquityLamports: end, netLamports: end - d.sodEquity, trades: closed.length, wins: closed.filter((t) => t.netLamports > 0n).length, lossLimitHit: d.lossLimitHit };
  });

  const exitReasons: Record<string, number> = {};
  for (const t of trades) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;

  const c = i.costs;
  let vsSol: BacktestReport['vsSol'] = null;
  if (i.solUsdStart && i.solUsdEnd && i.startingLamports > 0n) {
    const hold = (i.solUsdEnd / i.solUsdStart - 1) * 100;
    const strat = ((Number(i.endingLamports) * i.solUsdEnd) / (Number(i.startingLamports) * i.solUsdStart) - 1) * 100;
    vsSol = { solUsdStart: i.solUsdStart, solUsdEnd: i.solUsdEnd, holdSolReturnPct: hold, strategyUsdReturnPct: strat, excessPct: strat - hold };
  }

  return {
    synthetic: i.synthetic,
    label: i.synthetic ? SYNTHETIC_LABEL : 'Replay of recorded data. Cost model values are estimates until measured in paper and micro-live trading.',
    preset: i.preset,
    configVersion: i.configVersion,
    params: i.params,
    seed: i.seed,
    window: { from: new Date(i.from).toISOString(), to: new Date(i.to).toISOString() },
    startingEquityLamports: i.startingLamports,
    endingEquityLamports: i.endingLamports,
    summary: {
      trades: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length ? wins / trades.length : null,
      avgNetLamportsPerTrade: trades.length ? totalTradeNet / BigInt(trades.length) : null,
      totalTradeNetLamports: totalTradeNet,
      failedBuyBurnLamports: i.failedBuyBurnLamports,
      netAfterAllCostsLamports: totalTradeNet - i.failedBuyBurnLamports,
      maxDrawdownLamports: maxDd,
      maxDrawdownPct: maxDdPct,
      exitReasons,
      entries: i.entryStats,
      vetoes: i.vetoes,
      writtenOffPositions: i.writtenOff,
    },
    costs: {
      venueFeeLamports: c.venueFeeLamports,
      slippageLamports: c.slippageLamports,
      priceImpactLamports: c.priceImpactLamports,
      tipLamports: c.tipLamports,
      baseFeeLamports: c.baseFeeLamports,
      failedTxBurnLamports: c.failedTxBurnLamports,
      totalLamports: c.venueFeeLamports + c.slippageLamports + c.priceImpactLamports + c.tipLamports + c.baseFeeLamports + c.failedTxBurnLamports,
      filledTransactions: c.fills,
      failedTransactions: c.failures,
    },
    daily,
    lossLimitDayShare: daily.length ? daily.filter((d) => d.lossLimitHit).length / daily.length : null,
    vsSol,
    trades: trades.map((t) => ({
      positionId: t.positionId, mint: t.mint, symbol: t.symbol, openedAt: t.openedAt.toISOString(), closedAt: t.closedAt.toISOString(),
      holdSeconds: Math.round((t.closedAt.getTime() - t.openedAt.getTime()) / 1000),
      entryLamports: t.entryLamports, exitLamports: t.exitLamports, exitFailureBurnLamports: t.exitFailureBurnLamports, netLamports: t.netLamports, reason: t.reason,
    })),
  };
}

export function reportToJson(r: unknown): string {
  return JSON.stringify(toJsonSafe(r), null, 2);
}

const sol = (l: bigint | null) => (l === null ? 'n/a' : `${lamportsToSol(l).toFixed(4)} SOL`);
const pct = (n: number | null, d = 2) => (n === null ? 'n/a' : `${n.toFixed(d)}%`);

export function reportToMarkdown(r: BacktestReport, title = 'Backtest report'): string {
  const s = r.summary;
  const lines: string[] = [];
  lines.push(`# ${r.synthetic ? '[SYNTHETIC] ' : ''}${title}`, '');
  lines.push(`> ${r.label}`, '');
  lines.push(`- Preset: ${r.preset} (config ${r.configVersion})`);
  lines.push(`- Window: ${r.window.from} to ${r.window.to}`);
  lines.push(`- Paper failure seed: ${r.seed}`);
  lines.push(`- Equity: ${sol(r.startingEquityLamports)} to ${sol(r.endingEquityLamports)}`, '');
  lines.push('## Summary', '', '| Metric | Value |', '| --- | --- |');
  lines.push(`| Trades | ${s.trades} |`);
  lines.push(`| Win rate | ${s.winRate === null ? 'n/a' : pct(s.winRate * 100, 1)} |`);
  lines.push(`| Average net per trade | ${sol(s.avgNetLamportsPerTrade)} |`);
  lines.push(`| Total trade net | ${sol(s.totalTradeNetLamports)} |`);
  lines.push(`| Failed buy fee burn | ${sol(s.failedBuyBurnLamports)} |`);
  lines.push(`| Net after all costs | ${sol(s.netAfterAllCostsLamports)} |`);
  lines.push(`| Max drawdown | ${sol(s.maxDrawdownLamports)} (${pct(s.maxDrawdownPct)}) |`);
  lines.push(`| Days hitting loss limit | ${r.lossLimitDayShare === null ? 'n/a' : pct(r.lossLimitDayShare * 100, 1)} |`);
  lines.push(`| Exit reasons | ${Object.entries(s.exitReasons).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'} |`);
  lines.push(`| Entries (entered / vetoed / buy failed) | ${s.entries.entered} / ${s.entries.vetoed} / ${s.entries.buyFailed} |`);
  if (s.writtenOffPositions) lines.push(`| Positions written off at end | ${s.writtenOffPositions} |`);
  lines.push('');
  lines.push('## Costs', '', '| Item | Amount |', '| --- | --- |');
  lines.push(`| Venue fees | ${sol(r.costs.venueFeeLamports)} |`);
  lines.push(`| Slippage | ${sol(r.costs.slippageLamports)} |`);
  lines.push(`| Price impact | ${sol(r.costs.priceImpactLamports)} |`);
  lines.push(`| Tips | ${sol(r.costs.tipLamports)} |`);
  lines.push(`| Base fees | ${sol(r.costs.baseFeeLamports)} |`);
  lines.push(`| Failed transaction burn | ${sol(r.costs.failedTxBurnLamports)} |`);
  lines.push(`| Total | ${sol(r.costs.totalLamports)} |`, '');
  lines.push('## Daily P&L', '', '| Date | Start | End | Net | Trades | Wins | Loss limit hit |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const d of r.daily) {
    lines.push(`| ${d.date} | ${sol(d.startEquityLamports)} | ${sol(d.endEquityLamports)} | ${sol(d.netLamports)} | ${d.trades} | ${d.wins} | ${d.lossLimitHit ? 'yes' : 'no'} |`);
  }
  lines.push('');
  lines.push('## Versus holding SOL', '');
  if (r.vsSol) {
    lines.push(`SOL/USD ${r.vsSol.solUsdStart.toFixed(2)} to ${r.vsSol.solUsdEnd.toFixed(2)}. Holding SOL: ${pct(r.vsSol.holdSolReturnPct)}. Strategy (USD terms): ${pct(r.vsSol.strategyUsdReturnPct)}. Difference: ${pct(r.vsSol.excessPct)}.`);
  } else {
    lines.push('No SOL price series supplied; comparison not computed.');
  }
  lines.push('');
  return lines.join('\n');
}
