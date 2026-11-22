import { z } from 'zod';
import { HttpClient } from '../http.js';
import type { ScoutMetrics } from '../metrics.js';
import type { Collector, Logger, SignalSink } from '../types.js';
import { noopLogger, SignalKinds } from '../types.js';
import { clamp, sanitizeText, toFiniteNumber, WindowBudget } from '../util.js';

/*
 * Optional aggregated social metrics per watched token symbol. Disabled without an API key.
 * Requests are limited by a hard hourly budget (pay-as-you-go pricing). Symbols are ambiguous for
 * meme coins, so results are tagged as symbol-matched and the feature step down-weights them.
 */

const coinSchema = z.object({
  data: z.object({
    symbol: z.string().optional().nullable(),
    name: z.string().optional().nullable(),
    sentiment: z.union([z.number(), z.string()]).optional().nullable(),
    social_volume_24h: z.union([z.number(), z.string()]).optional().nullable(),
    interactions_24h: z.union([z.number(), z.string()]).optional().nullable(),
    galaxy_score: z.union([z.number(), z.string()]).optional().nullable(),
  }),
});

export interface WatchedToken {
  mint: string;
  symbol: string;
}

export interface LunarCrushCollectorOptions {
  sink: SignalSink;
  apiKey?: string;
  watched: () => WatchedToken[];
  baseUrl?: string;
  maxRequestsPerHour?: number;
  pollIntervalMs?: number;
  /** Minimum time between two polls of the same symbol. */
  minRepollMs?: number;
  http?: HttpClient;
  now?: () => Date;
  logger?: Logger;
  metrics?: ScoutMetrics;
}

/** Maps LunarCrush sentiment (percent positive, 0..100) to -1..1. */
export function normalizeSentiment(v: number | null): number | null {
  if (v === null) return null;
  return clamp((v - 50) / 50, -1, 1);
}

export class LunarCrushCollector implements Collector {
  readonly name = 'lunarcrush';
  readonly enabled: boolean;
  private readonly budget: WindowBudget;
  private readonly http: HttpClient;
  private readonly lastPolled = new Map<string, number>();
  private readonly now: () => Date;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: LunarCrushCollectorOptions) {
    this.enabled = !!opts.apiKey;
    this.now = opts.now ?? (() => new Date());
    this.budget = new WindowBudget(opts.maxRequestsPerHour ?? 60, 3_600_000, () => this.now().getTime());
    this.http = opts.http ?? new HttpClient({ secrets: opts.apiKey ? [opts.apiKey] : [] });
    this.logger = opts.logger ?? noopLogger;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      this.inflight = this.pollOnce()
        .then(() => undefined)
        .catch((e: unknown) =>
          this.logger.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'lunarcrush poll failed'),
        )
        .finally(() => {
          this.inflight = null;
        });
    }, this.opts.pollIntervalMs ?? 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
  }

  /** Polls at most one symbol. Returns false when nothing was requested. */
  async pollOnce(): Promise<boolean> {
    if (!this.enabled) return false;
    const now = this.now().getTime();
    const minRepoll = this.opts.minRepollMs ?? 10 * 60_000;
    const due = this.opts
      .watched()
      .filter((w) => /^[A-Za-z0-9]{1,16}$/.test(w.symbol))
      .filter((w) => now - (this.lastPolled.get(w.mint) ?? 0) >= minRepoll)
      .sort((a, b) => (this.lastPolled.get(a.mint) ?? 0) - (this.lastPolled.get(b.mint) ?? 0));
    const next = due[0];
    if (!next) return false;
    if (!this.budget.tryConsume(1)) {
      this.opts.metrics?.inc('lunarcrush.budget_exhausted');
      return false;
    }
    this.lastPolled.set(next.mint, now);
    if (this.lastPolled.size > 5_000) this.lastPolled.delete(this.lastPolled.keys().next().value!);
    const base = (this.opts.baseUrl ?? 'https://lunarcrush.com').replace(/\/+$/, '');
    const url = `${base}/api4/public/coins/${encodeURIComponent(next.symbol.toLowerCase())}/v1`;
    // One budget unit pays for exactly one request, so the budgeted call is never retried.
    const body = await this.http.json(url, coinSchema, {
      headers: { authorization: `Bearer ${String(this.opts.apiKey)}` },
      maxRetries: 0,
    });
    const d = body.data;
    if (d.symbol && d.symbol.toUpperCase() !== next.symbol.toUpperCase()) {
      this.opts.metrics?.inc('lunarcrush.symbol_mismatch');
      return true;
    }
    const volume24h = toFiniteNumber(d.social_volume_24h);
    this.opts.sink.emit({
      source: 'lunarcrush',
      mint: next.mint,
      kind: SignalKinds.socialMetrics,
      observedAt: this.now(),
      payload: {
        symbol: sanitizeText(next.symbol, 16),
        symbolMatched: true,
        mentionsPerMinute: volume24h !== null && volume24h >= 0 ? volume24h / 1440 : 0,
        sentiment: normalizeSentiment(toFiniteNumber(d.sentiment)),
        interactions24h: toFiniteNumber(d.interactions_24h),
        galaxyScore: toFiniteNumber(d.galaxy_score),
      },
    });
    return true;
  }
}
