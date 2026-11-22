import type { CreatorHintProvider, MarketInfo, MarketInfoProvider } from './safety.js';
import type { SignalEvent } from './types.js';
import { SignalKinds } from './types.js';
import { isMintAddress, LruMap, toFiniteNumber } from './util.js';

/*
 * In-memory state shared by the Scout cycle: a bounded recent-signal store per mint and a bounded
 * LRU watchlist of mints surfaced on-chain or by DEX Screener. Social posts are stored for
 * confirmation but never add a mint to the watchlist.
 */

export interface RecentSignalStoreOptions {
  maxMints?: number;
  maxEventsPerMint?: number;
  retentionMs?: number;
}

export class RecentSignalStore implements MarketInfoProvider, CreatorHintProvider {
  private readonly byMint: LruMap<string, SignalEvent[]>;
  private readonly maxEvents: number;
  private readonly retentionMs: number;

  constructor(opts: RecentSignalStoreOptions = {}, private readonly now: () => number = Date.now) {
    this.byMint = new LruMap(opts.maxMints ?? 2_000);
    this.maxEvents = opts.maxEventsPerMint ?? 600;
    this.retentionMs = opts.retentionMs ?? 45 * 60_000;
  }

  add(ev: SignalEvent): void {
    if (!ev.mint) return;
    const list = this.byMint.get(ev.mint) ?? [];
    list.push(ev);
    const cutoff = this.now() - this.retentionMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.observedAt.getTime() < cutoff) drop++;
    if (drop > 0) list.splice(0, drop);
    if (list.length > this.maxEvents) list.splice(0, list.length - this.maxEvents);
    this.byMint.set(ev.mint, list);
  }

  get(mint: string): SignalEvent[] {
    const cutoff = this.now() - this.retentionMs;
    return (this.byMint.peek(mint) ?? []).filter((e) => e.observedAt.getTime() >= cutoff);
  }

  latest(mint: string, kind: string): SignalEvent | null {
    const list = this.byMint.peek(mint) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.kind === kind) return list[i]!;
    return null;
  }

  market(mint: string): MarketInfo | null {
    const s = this.latest(mint, SignalKinds.pairSnapshot);
    if (!s) return null;
    const created = toFiniteNumber(s.payload.pairCreatedAt);
    const pair = typeof s.payload.pairAddress === 'string' && isMintAddress(s.payload.pairAddress) ? s.payload.pairAddress : null;
    return {
      liquidityUsd: Math.max(0, toFiniteNumber(s.payload.liquidityUsd) ?? 0),
      pairAddress: pair,
      pairCreatedAt: created !== null && created > 0 ? new Date(created) : null,
    };
  }

  creators(mint: string): string[] {
    const out = new Set<string>();
    for (const e of this.byMint.peek(mint) ?? []) {
      if (e.source !== 'helius' || e.kind !== SignalKinds.newToken) continue;
      for (const k of ['creator', 'user']) {
        const v = e.payload[k];
        if (typeof v === 'string' && isMintAddress(v)) out.add(v);
      }
    }
    return [...out];
  }
}

const SURFACING_KINDS = new Set<string>([
  SignalKinds.tokenProfile,
  SignalKinds.boost,
  SignalKinds.newToken,
  SignalKinds.migration,
  SignalKinds.newPool,
]);

/** True when an event may add its mint to the watchlist (on-chain or DEX Screener discovery only). */
export function isSurfacingEvent(ev: SignalEvent): boolean {
  return !!ev.mint && (ev.source === 'helius' || ev.source === 'dexscreener') && SURFACING_KINDS.has(ev.kind);
}

/**
 * Tokens the Scout scores each cycle.
 *
 * Brand-new launches (a Helius `new_token` event and nothing else) arrive far faster than the
 * scoring set can hold, and every preset has a minimum token age, so a plain LRU would evict them
 * before they could ever qualify. They therefore wait in a separate, larger holding tier keyed by
 * first-seen time and are promoted into the scoring set once they reach the preset's minimum age.
 * Any other surfacing event (DEX Screener listing or boost, migration, new pool) enters the
 * scoring set directly and also promotes the mint out of the holding tier.
 */
export class Watchlist {
  private readonly lru: LruMap<string, { addedAt: number; via: string }>;
  private readonly maturing: LruMap<string, { addedAt: number; via: string }>;
  private readonly blocked: LruMap<string, number>;

  constructor(
    maxSize = 300,
    private readonly blockMs = 60 * 60_000,
    private readonly now: () => number = Date.now,
    maturingSize = 20_000,
  ) {
    this.lru = new LruMap(maxSize);
    this.maturing = new LruMap(maturingSize);
    this.blocked = new LruMap(5_000);
  }

  get size(): number {
    return this.lru.size;
  }

  get maturingSize(): number {
    return this.maturing.size;
  }

  private isBlocked(mint: string): boolean {
    const until = this.blocked.peek(mint);
    return until !== undefined && until > this.now();
  }

  /**
   * Adds or refreshes a mint unless it is temporarily blocked. With `holdUntilMature`, a mint that
   * is not already being scored goes to the holding tier instead (first-seen time is kept).
   */
  touch(mint: string, via: string, holdUntilMature = false): boolean {
    if (!isMintAddress(mint)) return false;
    if (this.isBlocked(mint)) return false;
    if (holdUntilMature && !this.lru.has(mint)) {
      const prev = this.maturing.peek(mint);
      if (!prev) this.maturing.set(mint, { addedAt: this.now(), via });
      return true;
    }
    const held = this.maturing.peek(mint);
    if (held) this.maturing.delete(mint);
    const prev = this.lru.peek(mint);
    this.lru.set(mint, {
      addedAt: prev?.addedAt ?? held?.addedAt ?? this.now(),
      via: prev?.via ?? held?.via ?? via,
    });
    return true;
  }

  /**
   * Moves held mints first seen at least `minAgeMs` ago into the scoring set, oldest first, at most
   * `limit` per call. Returns how many were promoted.
   */
  promoteMature(minAgeMs: number, limit = 100): number {
    const cutoff = this.now() - Math.max(0, minAgeMs);
    const ready: Array<[string, { addedAt: number; via: string }]> = [];
    for (const [mint, entry] of this.maturing.entries()) {
      if (ready.length >= limit) break;
      if (entry.addedAt <= cutoff) ready.push([mint, entry]);
    }
    let promoted = 0;
    for (const [mint, entry] of ready) {
      this.maturing.delete(mint);
      if (this.isBlocked(mint)) continue;
      const prev = this.lru.peek(mint);
      this.lru.set(mint, { addedAt: prev?.addedAt ?? entry.addedAt, via: prev?.via ?? entry.via });
      promoted++;
    }
    return promoted;
  }

  has(mint: string): boolean {
    return this.lru.has(mint);
  }

  /** Removes a mint and keeps it out for `blockMs` (used for permanent safety failures). */
  block(mint: string): void {
    this.lru.delete(mint);
    this.maturing.delete(mint);
    this.blocked.set(mint, this.now() + this.blockMs);
  }

  mints(): string[] {
    return this.lru.keysMostRecentFirst();
  }
}
