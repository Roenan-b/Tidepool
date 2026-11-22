import { z } from 'zod';
import { HttpClient } from '../http.js';
import type { ScoutMetrics } from '../metrics.js';
import type { Collector, Logger, SignalEvent, SignalSink } from '../types.js';
import { noopLogger, SignalKinds } from '../types.js';
import { isMintAddress, redactUrl, sanitizeText, TokenBucket, toFiniteNumber } from '../util.js';

/*
 * DEX Screener public API. Documented limits: token profiles and boosts 60 requests/min,
 * pairs/tokens 300 requests/min, and at most 30 token addresses per tokens call.
 * Records are validated one by one: unknown fields are tolerated, bad records are skipped and counted.
 */

const num = z.union([z.number(), z.string()]).transform((v) => toFiniteNumber(v));
const optNum = num.optional().nullable();

const linkSchema = z.object({
  type: z.string().optional().nullable(),
  label: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
});

export const profileSchema = z.object({
  chainId: z.string(),
  tokenAddress: z.string(),
  url: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  links: z.array(linkSchema).optional().nullable(),
});

export const boostSchema = profileSchema.extend({
  amount: optNum,
  totalAmount: optNum,
});

const txnSchema = z.object({ buys: optNum, sells: optNum }).partial();

export const pairSchema = z.object({
  chainId: z.string(),
  dexId: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  pairAddress: z.string(),
  labels: z.array(z.string()).optional().nullable(),
  baseToken: z.object({ address: z.string(), name: z.string().optional().nullable(), symbol: z.string().optional().nullable() }),
  quoteToken: z.object({ address: z.string(), symbol: z.string().optional().nullable() }).optional().nullable(),
  priceNative: optNum,
  priceUsd: optNum,
  txns: z.object({ m5: txnSchema.optional().nullable(), h1: txnSchema.optional().nullable(), h24: txnSchema.optional().nullable() }).partial().optional().nullable(),
  volume: z.object({ m5: optNum, h1: optNum, h6: optNum, h24: optNum }).partial().optional().nullable(),
  priceChange: z.object({ m5: optNum, h1: optNum, h6: optNum, h24: optNum }).partial().optional().nullable(),
  liquidity: z.object({ usd: optNum, base: optNum, quote: optNum }).partial().optional().nullable(),
  fdv: optNum,
  marketCap: optNum,
  pairCreatedAt: optNum,
  info: z
    .object({
      websites: z.array(z.object({ url: z.string().optional().nullable(), label: z.string().optional().nullable() })).optional().nullable(),
      socials: z
        .array(z.object({ platform: z.string().optional().nullable(), type: z.string().optional().nullable(), handle: z.string().optional().nullable(), url: z.string().optional().nullable() }))
        .optional()
        .nullable(),
    })
    .optional()
    .nullable(),
  boosts: z.object({ active: optNum }).optional().nullable(),
});
export type DexPair = z.infer<typeof pairSchema>;

const tokensResponseSchema = z.object({ pairs: z.array(z.unknown()).nullable().optional() });

export interface ParseStats {
  ok: number;
  skipped: number;
}

/** Normalizes a list endpoint body (array, or a single object) and validates each record. */
export function parseRecords<T>(body: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): { records: T[]; stats: ParseStats } {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : [];
  const records: T[] = [];
  let skipped = 0;
  for (const item of list) {
    const r = schema.safeParse(item);
    if (r.success) records.push(r.data);
    else skipped++;
  }
  return { records, stats: { ok: records.length, skipped } };
}

function cleanLinks(links: Array<z.infer<typeof linkSchema>> | null | undefined): Array<{ type: string; url: string }> {
  return (links ?? [])
    .slice(0, 10)
    .map((l) => ({ type: sanitizeText(l.type ?? l.label ?? 'website', 32), url: sanitizeText(l.url ?? '', 256) }))
    .filter((l) => l.url.startsWith('https://'));
}

export function profileToSignal(p: z.infer<typeof profileSchema>, observedAt: Date): SignalEvent | null {
  if (p.chainId !== 'solana' || !isMintAddress(p.tokenAddress)) return null;
  return {
    source: 'dexscreener',
    mint: p.tokenAddress,
    kind: SignalKinds.tokenProfile,
    observedAt,
    payload: { description: sanitizeText(p.description ?? '', 1000), links: cleanLinks(p.links) },
  };
}

export function boostToSignal(b: z.infer<typeof boostSchema>, observedAt: Date): SignalEvent | null {
  if (b.chainId !== 'solana' || !isMintAddress(b.tokenAddress)) return null;
  return {
    source: 'dexscreener',
    mint: b.tokenAddress,
    kind: SignalKinds.boost,
    observedAt,
    payload: {
      boosted: true,
      amount: b.amount ?? null,
      totalAmount: b.totalAmount ?? null,
      description: sanitizeText(b.description ?? '', 1000),
      links: cleanLinks(b.links),
    },
  };
}

/**
 * Quote tokens whose USD price DEX Screener cannot be tricked into inflating (wrapped SOL, USDC,
 * USDT). A pair quoted in an arbitrary token can report any liquidity, so it is never used.
 */
export const TRUSTED_QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

/** Picks the deepest Solana pair whose base token is `mint` and maps it to a snapshot signal. */
export function pairsToSnapshot(mint: string, pairs: DexPair[], observedAt: Date): SignalEvent | null {
  const own = pairs.filter(
    (p) =>
      p.chainId === 'solana' &&
      p.baseToken.address === mint &&
      isMintAddress(p.pairAddress) &&
      !!p.quoteToken &&
      TRUSTED_QUOTE_MINTS.has(p.quoteToken.address),
  );
  if (own.length === 0) return null;
  own.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const p = own[0]!;
  const boostsActive = p.boosts?.active ?? 0;
  const socials = (p.info?.socials ?? []).slice(0, 10).map((s) => ({
    platform: sanitizeText(s.platform ?? s.type ?? 'unknown', 32),
    handle: sanitizeText(s.handle ?? s.url ?? '', 256),
  }));
  const websites = (p.info?.websites ?? [])
    .slice(0, 5)
    .map((w) => sanitizeText(w.url ?? '', 256))
    .filter((u) => u.startsWith('https://'));
  return {
    source: 'dexscreener',
    mint,
    kind: SignalKinds.pairSnapshot,
    observedAt,
    payload: {
      pairAddress: p.pairAddress,
      dexId: sanitizeText(p.dexId ?? '', 32),
      symbol: sanitizeText(p.baseToken.symbol ?? '', 16),
      name: sanitizeText(p.baseToken.name ?? '', 64),
      quoteSymbol: sanitizeText(p.quoteToken?.symbol ?? '', 16),
      priceUsd: p.priceUsd ?? null,
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume5mUsd: p.volume?.m5 ?? 0,
      volume1hUsd: p.volume?.h1 ?? 0,
      volume24hUsd: p.volume?.h24 ?? 0,
      priceChange5mPct: p.priceChange?.m5 ?? 0,
      priceChange1hPct: p.priceChange?.h1 ?? 0,
      buys5m: p.txns?.m5?.buys ?? 0,
      sells5m: p.txns?.m5?.sells ?? 0,
      buys1h: p.txns?.h1?.buys ?? 0,
      sells1h: p.txns?.h1?.sells ?? 0,
      fdv: p.fdv ?? null,
      marketCap: p.marketCap ?? null,
      pairCreatedAt: p.pairCreatedAt ?? null,
      boostsActive,
      boosted: boostsActive > 0,
      socials,
      websites,
      labels: (p.labels ?? []).slice(0, 5).map((l) => sanitizeText(l, 32)),
      pairCount: own.length,
    },
  };
}

export interface DexScreenerCollectorOptions {
  sink: SignalSink;
  /** Mints to fetch pair data for (the Scout watchlist). */
  watched: () => string[];
  baseUrl?: string;
  http?: HttpClient;
  profilesIntervalMs?: number;
  pairsIntervalMs?: number;
  /** Max tokens calls per pairs tick (each call covers up to 30 mints). */
  maxPairCallsPerTick?: number;
  profileLimiter?: TokenBucket;
  pairLimiter?: TokenBucket;
  logger?: Logger;
  metrics?: ScoutMetrics;
  now?: () => Date;
}

export const DEX_MAX_ADDRESSES_PER_CALL = 30;

export class DexScreenerCollector implements Collector {
  readonly name = 'dexscreener';
  private readonly baseUrl: string;
  private readonly http: HttpClient;
  private readonly profileLimiter: TokenBucket;
  private readonly pairLimiter: TokenBucket;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  private stopped = false;
  private inflight = new Set<Promise<unknown>>();
  private pairCursor = 0;

  constructor(private readonly opts: DexScreenerCollectorOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.dexscreener.com').replace(/\/+$/, '');
    if (!this.baseUrl.startsWith('https://') && !this.baseUrl.startsWith('http://127.0.0.1')) {
      throw new Error('DEX Screener base URL must be https');
    }
    this.http = opts.http ?? new HttpClient();
    // Profiles and boosts share one conservative 60 rpm bucket.
    this.profileLimiter = opts.profileLimiter ?? TokenBucket.perMinute(60, 2);
    this.pairLimiter = opts.pairLimiter ?? TokenBucket.perMinute(300, 5);
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const every = (ms: number, fn: () => Promise<void>) => {
      // One run per poller at a time: a slow or rate-limited API must not stack up overlapping
      // polls (each with its own retries and limiter waits).
      let busy = false;
      const run = () => {
        if (!this.running) return;
        if (busy) {
          this.count('poll_skipped_busy');
          return;
        }
        busy = true;
        const p = fn()
          .catch((e) => this.logger.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'dexscreener poll failed'))
          .finally(() => {
            busy = false;
          });
        this.inflight.add(p);
        void p.finally(() => this.inflight.delete(p));
      };
      run();
      const t = setInterval(run, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.opts.profilesIntervalMs ?? 10_000, () => this.pollProfilesAndBoosts());
    every(this.opts.pairsIntervalMs ?? 5_000, () => this.pollPairs());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await Promise.allSettled([...this.inflight]);
  }

  private count(name: string, n = 1): void {
    this.opts.metrics?.inc(`dexscreener.${name}`, n);
  }

  async pollProfilesAndBoosts(): Promise<void> {
    const observedAt = this.now();
    const profiles = await this.http.rawJson(`${this.baseUrl}/token-profiles/latest/v1`, { limiter: this.profileLimiter });
    const pr = parseRecords(profiles, profileSchema);
    this.count('records_skipped', pr.stats.skipped);
    for (const p of pr.records) {
      const s = profileToSignal(p, observedAt);
      if (s) this.opts.sink.emit(s);
    }
    const boosts = await this.http.rawJson(`${this.baseUrl}/token-boosts/latest/v1`, { limiter: this.profileLimiter });
    const br = parseRecords(boosts, boostSchema);
    this.count('records_skipped', br.stats.skipped);
    for (const b of br.records) {
      const s = boostToSignal(b, observedAt);
      if (s) this.opts.sink.emit(s);
    }
  }

  /** Fetches pair data for the watchlist in chunks of 30, rotating through it across ticks. */
  async pollPairs(): Promise<void> {
    const mints = [...new Set(this.opts.watched().filter(isMintAddress))];
    if (mints.length === 0) return;
    const chunks: string[][] = [];
    for (let i = 0; i < mints.length; i += DEX_MAX_ADDRESSES_PER_CALL) chunks.push(mints.slice(i, i + DEX_MAX_ADDRESSES_PER_CALL));
    const maxCalls = Math.max(1, this.opts.maxPairCallsPerTick ?? 4);
    for (let k = 0; k < Math.min(maxCalls, chunks.length); k++) {
      if (this.stopped) return;
      const chunk = chunks[(this.pairCursor + k) % chunks.length]!;
      await this.fetchPairs(chunk);
    }
    this.pairCursor = (this.pairCursor + maxCalls) % Math.max(1, chunks.length);
  }

  async fetchPairs(chunk: string[]): Promise<void> {
    const url = `${this.baseUrl}/latest/dex/tokens/${chunk.join(',')}`;
    const body = await this.http.json(url, tokensResponseSchema, { limiter: this.pairLimiter });
    const pr = parseRecords(body.pairs ?? [], pairSchema);
    this.count('records_skipped', pr.stats.skipped);
    const observedAt = this.now();
    for (const mint of chunk) {
      const s = pairsToSnapshot(mint, pr.records, observedAt);
      if (s) this.opts.sink.emit(s);
      else this.count('no_pair');
    }
    this.logger.debug({ url: redactUrl(url), pairs: pr.records.length }, 'dexscreener pairs');
  }
}
