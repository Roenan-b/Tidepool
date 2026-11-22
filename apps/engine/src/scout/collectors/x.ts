import { z } from 'zod';
import { HttpClient } from '../http.js';
import type { ScoutMetrics } from '../metrics.js';
import type { Collector, Logger, SignalSink } from '../types.js';
import { noopLogger, SignalKinds } from '../types.js';
import { isMintAddress, sanitizeText, WindowBudget } from '../util.js';
import { parseRecords } from './dexscreener.js';

/*
 * Optional curated X reader. Reads recent posts only from configured user ids through the v2 user
 * posts endpoint. X bills per post read, so X_MAX_READS_PER_HOUR is a hard budget: each request
 * reserves its maximum possible reads (posts plus the expanded author) before it is sent.
 * Posts never add tokens to the watchlist; they only attach to tokens already surfaced on-chain.
 */

const tweetSchema = z.object({
  id: z.string().regex(/^\d{1,25}$/),
  text: z.string(),
  created_at: z.string().optional(),
  author_id: z.string().optional(),
  entities: z.object({ cashtags: z.array(z.object({ tag: z.string() })).optional() }).partial().optional().nullable(),
});

const userSchema = z.object({
  id: z.string(),
  created_at: z.string().optional(),
  verified: z.boolean().optional(),
  public_metrics: z.object({ followers_count: z.number().optional(), following_count: z.number().optional() }).partial().optional(),
});

const timelineSchema = z.object({
  data: z.array(z.unknown()).optional(),
  includes: z.object({ users: z.array(z.unknown()).optional() }).partial().optional(),
  meta: z.object({ newest_id: z.string().optional(), result_count: z.number().optional() }).partial().optional(),
});

const MINT_CANDIDATE_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9_]{0,15})\b/g;

/** Base58 strings in `text` that parse as canonical 32-byte public keys. */
export function extractMints(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(MINT_CANDIDATE_RE) ?? []) {
    if (isMintAddress(m)) out.add(m);
    if (out.size >= 5) break;
  }
  return [...out];
}

export function extractCashtags(text: string, entityTags: string[] = []): string[] {
  const out = new Set<string>(entityTags.map((t) => t.toUpperCase()).filter((t) => /^[A-Z][A-Z0-9_]{0,15}$/.test(t)));
  for (const m of text.matchAll(CASHTAG_RE)) out.add(m[1]!.toUpperCase());
  return [...out].slice(0, 10);
}

export interface XCuratedCollectorOptions {
  sink: SignalSink;
  bearerToken?: string;
  userIds: string[];
  maxReadsPerHour: number;
  /** Watched token symbols (upper case) to mints; used to attach cashtag-only posts. */
  watchedSymbols?: () => Map<string, string>;
  maxResultsPerCall?: number;
  pollIntervalMs?: number;
  baseUrl?: string;
  http?: HttpClient;
  now?: () => Date;
  logger?: Logger;
  metrics?: ScoutMetrics;
}

export class XCuratedCollector implements Collector {
  readonly name = 'x';
  readonly enabled: boolean;
  private readonly userIds: string[];
  private readonly budget: WindowBudget;
  private readonly http: HttpClient;
  private readonly sinceId = new Map<string, string>();
  private readonly now: () => Date;
  private readonly logger: Logger;
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> | null = null;

  constructor(private readonly opts: XCuratedCollectorOptions) {
    this.userIds = [...new Set(opts.userIds.map((s) => s.trim()).filter((s) => /^\d{1,20}$/.test(s)))].slice(0, 500);
    this.enabled = !!opts.bearerToken && this.userIds.length > 0 && opts.maxReadsPerHour > 0;
    this.now = opts.now ?? (() => new Date());
    this.budget = new WindowBudget(Math.max(0, Math.floor(opts.maxReadsPerHour)), 3_600_000, () => this.now().getTime());
    this.http = opts.http ?? new HttpClient({ maxRetries: 1, secrets: opts.bearerToken ? [opts.bearerToken] : [] });
    this.logger = opts.logger ?? noopLogger;
  }

  get remainingReads(): number {
    return this.budget.remaining();
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      this.inflight = this.pollOnce()
        .catch((e) => this.logger.warn({ err: e instanceof Error ? e.message : 'unknown' }, 'x poll failed'))
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

  /** Reads one user's recent posts if the budget allows. Returns the number of posts read. */
  async pollOnce(): Promise<number> {
    if (!this.enabled) return 0;
    const userId = this.userIds[this.cursor % this.userIds.length]!;
    this.cursor = (this.cursor + 1) % this.userIds.length;
    const configured = Math.min(100, Math.max(5, this.opts.maxResultsPerCall ?? 10));
    const remaining = this.budget.remaining();
    // One read is reserved for the expanded author object.
    const maxResults = Math.min(configured, remaining - 1);
    if (maxResults < 5) {
      this.opts.metrics?.inc('x.budget_exhausted');
      return 0;
    }
    if (!this.budget.tryConsume(maxResults + 1)) return 0;

    const base = (this.opts.baseUrl ?? 'https://api.x.com').replace(/\/+$/, '');
    const params = new URLSearchParams({
      max_results: String(maxResults),
      'tweet.fields': 'created_at,author_id,entities',
      expansions: 'author_id',
      'user.fields': 'created_at,public_metrics,verified',
      exclude: 'retweets',
    });
    const since = this.sinceId.get(userId);
    if (since) params.set('since_id', since);
    const body = await this.http.json(`${base}/2/users/${userId}/tweets?${params.toString()}`, timelineSchema, {
      headers: { authorization: `Bearer ${this.opts.bearerToken}` },
      // The reservation above covers exactly one request; a retry could be billed again.
      maxRetries: 0,
    });
    const tweets = parseRecords(body.data ?? [], tweetSchema);
    const users = parseRecords(body.includes?.users ?? [], userSchema);
    this.opts.metrics?.inc('x.records_skipped', tweets.stats.skipped + users.stats.skipped);
    this.opts.metrics?.inc('x.reads', tweets.records.length + users.records.length);
    if (body.meta?.newest_id && /^\d{1,25}$/.test(body.meta.newest_id)) this.sinceId.set(userId, body.meta.newest_id);

    const author = users.records.find((u) => u.id === userId) ?? users.records[0];
    const nowMs = this.now().getTime();
    const createdMs = author?.created_at ? Date.parse(author.created_at) : NaN;
    const quality = {
      accountAgeDays: Number.isFinite(createdMs) ? Math.max(0, (nowMs - createdMs) / 86_400_000) : null,
      followers: author?.public_metrics?.followers_count ?? null,
      following: author?.public_metrics?.following_count ?? null,
      verified: author?.verified ?? null,
      curated: true,
    };
    const symbols = this.opts.watchedSymbols?.() ?? new Map<string, string>();

    for (const t of tweets.records) {
      const text = sanitizeText(t.text, 500);
      const cashtags = extractCashtags(text, (t.entities?.cashtags ?? []).map((c) => c.tag));
      const mints = new Map<string, 'mint' | 'cashtag'>();
      for (const m of extractMints(text)) mints.set(m, 'mint');
      for (const tag of cashtags) {
        const m = symbols.get(tag);
        if (m && !mints.has(m)) mints.set(m, 'cashtag');
      }
      const postedMs = t.created_at ? Date.parse(t.created_at) : NaN;
      const observedAt = Number.isFinite(postedMs) && postedMs <= nowMs ? new Date(postedMs) : this.now();
      const payload = { postId: t.id, authorId: userId, text, cashtags, quality };
      if (mints.size === 0) {
        this.opts.sink.emit({ source: 'x', mint: null, kind: SignalKinds.post, observedAt, payload: { ...payload, matchedBy: null } });
      }
      for (const [mint, matchedBy] of mints) {
        this.opts.sink.emit({ source: 'x', mint, kind: SignalKinds.post, observedAt, payload: { ...payload, matchedBy } });
      }
    }
    return tweets.records.length;
  }
}
