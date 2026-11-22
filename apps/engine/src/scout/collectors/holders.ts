import { z } from 'zod';
import { HttpClient } from '../http.js';
import type { ScoutMetrics } from '../metrics.js';
import type { Collector, Logger, SignalSink } from '../types.js';
import { noopLogger, SignalKinds } from '../types.js';
import { isMintAddress, TokenBucket } from '../util.js';

/*
 * Holder-count snapshots for watched mints, the on-chain confirmation input for holder growth.
 * Counting holders needs an indexer; the bundled provider uses the Helius DAS `getTokenAccounts`
 * method with a page cap, so very widely held tokens report a lower bound (`capped: true`).
 */

export interface HolderCountProvider {
  holderCount(mint: string): Promise<{ count: number; capped: boolean } | null>;
}

const dasResponseSchema = z.object({
  result: z
    .object({
      token_accounts: z
        .array(z.object({ owner: z.string(), amount: z.union([z.number(), z.string()]) }).passthrough())
        .default([]),
    })
    .optional()
    .nullable(),
  error: z.object({ message: z.string().optional() }).passthrough().optional().nullable(),
});

export interface HeliusDasHolderCounterOptions {
  /** Helius RPC URL (it carries the API key; it is only ever logged redacted). */
  rpcUrl: string;
  maxPages?: number;
  pageSize?: number;
  http?: HttpClient;
  limiter?: TokenBucket;
}

export class HeliusDasHolderCounter implements HolderCountProvider {
  private readonly http: HttpClient;
  private readonly limiter: TokenBucket;
  constructor(private readonly opts: HeliusDasHolderCounterOptions) {
    if (!opts.rpcUrl.startsWith('https://')) throw new Error('holder counter RPC URL must be https');
    this.http = opts.http ?? new HttpClient({ maxRetries: 2 });
    // Free Helius plans allow 10 requests/second; stay well under it.
    this.limiter = opts.limiter ?? new TokenBucket(3, 3);
  }

  async holderCount(mint: string): Promise<{ count: number; capped: boolean } | null> {
    if (!isMintAddress(mint)) return null;
    const owners = new Set<string>();
    const maxPages = Math.max(1, this.opts.maxPages ?? 3);
    const limit = Math.min(1000, Math.max(1, this.opts.pageSize ?? 1000));
    for (let page = 1; page <= maxPages; page++) {
      const body = await this.http.json(this.opts.rpcUrl, dasResponseSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `holders-${page}`,
          method: 'getTokenAccounts',
          params: { mint, page, limit },
        }),
        limiter: this.limiter,
      });
      if (body.error || !body.result) return null;
      const accounts = body.result.token_accounts;
      for (const a of accounts) {
        const amt = typeof a.amount === 'number' ? a.amount > 0 : /^[1-9]\d*$/.test(a.amount);
        if (amt) owners.add(a.owner);
      }
      if (accounts.length < limit) return { count: owners.size, capped: false };
    }
    return { count: owners.size, capped: true };
  }
}

export interface HolderStatsCollectorOptions {
  sink: SignalSink;
  provider: HolderCountProvider;
  watched: () => string[];
  intervalMs?: number;
  mintsPerTick?: number;
  now?: () => Date;
  logger?: Logger;
  metrics?: ScoutMetrics;
}

export class HolderStatsCollector implements Collector {
  readonly name = 'holders';
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private cursor = 0;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(private readonly opts: HolderStatsCollectorOptions) {
    this.now = opts.now ?? (() => new Date());
    this.logger = opts.logger ?? noopLogger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      this.inflight = this.pollOnce().finally(() => {
        this.inflight = null;
      });
    }, this.opts.intervalMs ?? 10_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inflight;
  }

  async pollOnce(): Promise<void> {
    const mints = this.opts.watched();
    if (mints.length === 0) return;
    const n = Math.min(mints.length, this.opts.mintsPerTick ?? 5);
    for (let i = 0; i < n; i++) {
      const mint = mints[(this.cursor + i) % mints.length]!;
      try {
        const r = await this.opts.provider.holderCount(mint);
        if (!r) continue;
        this.opts.sink.emit({
          source: 'holders',
          mint,
          kind: SignalKinds.holderSnapshot,
          observedAt: this.now(),
          payload: { holderCount: r.count, capped: r.capped },
        });
      } catch (e) {
        this.opts.metrics?.inc('holders.errors');
        this.logger.debug({ err: e instanceof Error ? e.message : 'unknown' }, 'holder count failed');
      }
    }
    this.cursor = (this.cursor + n) % mints.length;
  }
}
