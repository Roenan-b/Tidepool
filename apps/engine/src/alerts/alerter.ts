import type { HaltReason, TradingMode } from '@tidepool/core';
import type { Logger } from '../log.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export type AlertKind =
  | 'halt'
  | 'halt_cleared'
  | 'kill_switch'
  | 'reconciliation_error'
  | 'withdraw_address_change'
  | 'withdrawal'
  | 'mode_change'
  | 'accounting_warning';

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  mode: TradingMode;
  title: string;
  /** Plain text; never include secrets, keys or tickets. */
  body: string;
  haltReason?: HaltReason;
}

export interface DailySummary {
  mode: TradingMode;
  date: string;                 // UTC YYYY-MM-DD
  equityLamports: bigint;
  startOfDayEquityLamports: bigint;
  netPnlLamports: bigint;
  realizedPnlLamports: bigint;
  trades: number;
  wins: number;
  solUsd: number | null;
  engineState: string;
  haltReason: string | null;
}

/** Outbound notification channel used by the Risk Officer. Implementations must never throw. */
export interface Alerter {
  notify(alert: Alert): Promise<void>;
  dailySummary(summary: DailySummary): Promise<void>;
}

export class NullAlerter implements Alerter {
  async notify(): Promise<void> {}
  async dailySummary(): Promise<void> {}
}

/** Collects alerts in memory; useful in tests and for a dashboard "recent alerts" panel. */
export class MemoryAlerter implements Alerter {
  readonly alerts: Alert[] = [];
  readonly summaries: DailySummary[] = [];
  constructor(private readonly max = 500) {}
  async notify(alert: Alert): Promise<void> {
    this.alerts.push(alert);
    if (this.alerts.length > this.max) this.alerts.shift();
  }
  async dailySummary(summary: DailySummary): Promise<void> {
    this.summaries.push(summary);
    if (this.summaries.length > this.max) this.summaries.shift();
  }
}

function sol(lamports: bigint): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4);
  return `${neg ? '-' : ''}${whole}.${frac} SOL`;
}

export function formatAlert(a: Alert): string {
  const tag = a.severity === 'critical' ? '[CRITICAL]' : a.severity === 'warning' ? '[WARNING]' : '[INFO]';
  return `${tag} Tidepool ${a.mode.toUpperCase()}: ${a.title}\n${a.body}`;
}

export function formatDailySummary(s: DailySummary): string {
  const usd = (l: bigint) => (s.solUsd ? ` (~$${((Number(l) / 1e9) * s.solUsd).toFixed(2)})` : '');
  return [
    `Tidepool ${s.mode.toUpperCase()} daily summary for ${s.date} (UTC)`,
    `Net P&L: ${sol(s.netPnlLamports)}${usd(s.netPnlLamports)}`,
    `Realized: ${sol(s.realizedPnlLamports)}`,
    `Pool value: ${sol(s.equityLamports)} (start of day ${sol(s.startOfDayEquityLamports)})`,
    `Trades: ${s.trades}, wins: ${s.wins}`,
    `State: ${s.engineState}${s.haltReason ? ` (${s.haltReason})` : ''}`,
  ].join('\n');
}

export interface TelegramAlerterOptions {
  botToken: string;
  chatId: string;
  timeoutMs?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Max concurrent sends; extra alerts are dropped (and logged) rather than queued without bound. */
  maxInFlight?: number;
}

const TELEGRAM_MAX_TEXT = 4096;

/**
 * Sends alerts through the Telegram Bot API (sendMessage). The bot token is part of the request
 * URL, so the URL is never logged; errors are reduced to a status code or error name.
 */
export class TelegramAlerter implements Alerter {
  private readonly url: string;
  private readonly chatId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly maxInFlight: number;
  private inFlight = 0;

  constructor(opts: TelegramAlerterOptions) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(opts.botToken)) throw new Error('telegram bot token has an unexpected format');
    if (!/^-?\d{1,20}$|^@[A-Za-z0-9_]{5,64}$/.test(opts.chatId)) throw new Error('telegram chat id has an unexpected format');
    const base = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.url = `${base}/bot${opts.botToken}/sendMessage`;
    this.chatId = opts.chatId;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = opts.logger;
    this.maxInFlight = opts.maxInFlight ?? 10;
  }

  notify(alert: Alert): Promise<void> {
    return this.send(formatAlert(alert));
  }

  dailySummary(summary: DailySummary): Promise<void> {
    return this.send(formatDailySummary(summary));
  }

  /** Sends plain text (no parse mode, so token names or symbols cannot inject markup). Never throws. */
  async send(text: string): Promise<void> {
    if (this.inFlight >= this.maxInFlight) {
      this.logger?.warn({ inFlight: this.inFlight }, 'telegram alert dropped: too many in flight');
      return;
    }
    this.inFlight++;
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, TELEGRAM_MAX_TEXT), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) this.logger?.warn({ status: res.status }, 'telegram sendMessage failed');
    } catch (err) {
      this.logger?.warn({ error: err instanceof Error ? err.name : 'unknown' }, 'telegram sendMessage error');
    } finally {
      this.inFlight--;
    }
  }
}

/** Returns a TelegramAlerter when both token and chat id are configured, otherwise a NullAlerter. */
export function createAlerter(cfg: { telegram: { botToken: string; chatId: string } | null }, logger?: Logger): Alerter {
  if (!cfg.telegram) return new NullAlerter();
  return new TelegramAlerter({ botToken: cfg.telegram.botToken, chatId: cfg.telegram.chatId, ...(logger ? { logger } : {}) });
}
