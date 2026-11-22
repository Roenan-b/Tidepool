import { PublicKey } from '@solana/web3.js';

export type SleepFn = (ms: number) => Promise<void>;
export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Token bucket rate limiter. `capacity` tokens refill continuously at `refillPerSecond`.
 * `take()` waits until a token is available; waiters are served in FIFO order.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!(capacity >= 1) || !(refillPerSecond > 0)) throw new RangeError('invalid token bucket parameters');
    this.tokens = capacity;
    this.last = now();
  }

  /** Builds a bucket for a documented requests-per-minute limit with a small burst allowance. */
  static perMinute(
    rpm: number,
    burst = Math.max(1, Math.floor(rpm / 10)),
    now?: () => number,
    sleep?: SleepFn,
  ): TokenBucket {
    return new TokenBucket(burst, rpm / 60, now, sleep);
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
  }

  /** Non-blocking: consumes a token if one is available. */
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  available(): number {
    this.refill();
    return this.tokens;
  }

  take(): Promise<void> {
    const next = this.queue.then(async () => {
      for (;;) {
        if (this.tryTake()) return;
        const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
        await this.sleep(Math.max(1, waitMs));
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * Hard sliding-window budget (for example X reads per hour or model calls per hour).
 * `tryConsume(n)` succeeds only if `n` units fit in the last `windowMs`.
 */
export class WindowBudget {
  private readonly entries: { at: number; n: number }[] = [];
  private used = 0;

  constructor(
    readonly limit: number,
    private readonly windowMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!(limit >= 0) || !Number.isFinite(limit)) throw new RangeError('invalid budget limit');
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.entries.length > 0 && this.entries[0]!.at <= cutoff) {
      this.used -= this.entries.shift()!.n;
    }
  }

  remaining(): number {
    this.prune();
    return Math.max(0, this.limit - this.used);
  }

  tryConsume(n = 1): boolean {
    if (n <= 0) return true;
    this.prune();
    if (this.used + n > this.limit) return false;
    this.entries.push({ at: this.now(), n });
    this.used += n;
    return true;
  }

  /** Records usage that already happened (for example reads billed by a response), even past the limit. */
  charge(n: number): void {
    if (n <= 0) return;
    this.prune();
    this.entries.push({ at: this.now(), n });
    this.used += n;
  }
}

/** Bounded map with least-recently-used eviction. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(
    readonly maxSize: number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {
    if (!(maxSize >= 1)) throw new RangeError('maxSize must be >= 1');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const ov = this.map.get(oldest.value)!;
      this.map.delete(oldest.value);
      this.onEvict?.(oldest.value, ov);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  /** Keys from most to least recently used. */
  keysMostRecentFirst(): K[] {
    return [...this.map.keys()].reverse();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

/** Full-jitter exponential backoff delay for attempt `n` (0-based). */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.floor(random() * cap);
}

/**
 * Removes query strings, fragments and credentials from a URL so that API keys passed as
 * query parameters or userinfo never reach logs or error messages.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

// Control characters (C0 and C1) and Unicode bidi/zero-width format characters.
// eslint-disable-next-line no-control-regex -- strips control characters on purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

// A UTF-16 surrogate without its partner. Postgres rejects these inside jsonb.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Strips control and invisible formatting characters and unpaired surrogates, collapses
 * whitespace, caps length. The cap never splits a surrogate pair.
 */
export function sanitizeText(input: unknown, maxLen: number): string {
  if (typeof input !== 'string') return '';
  const cleaned = input.replace(CONTROL_CHARS, ' ').replace(LONE_SURROGATE, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  let out = cleaned.slice(0, maxLen);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Makes a string storable in a Postgres text or jsonb value: drops NUL, replaces unpaired surrogates. */
export function pgSafeString(s: string): string {
  // eslint-disable-next-line no-control-regex -- Postgres text cannot store NUL
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '\uFFFD');
}

/** JSON.stringify for jsonb parameters; every string value goes through `pgSafeString`. */
export function toPgJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'string' ? pgSafeString(v) : v));
}

/** True when `s` is a canonical base58 32-byte public key. */
export function isMintAddress(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
}

export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Parses a finite number from a number or numeric string; returns null otherwise. */
export function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
