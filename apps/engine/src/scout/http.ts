import type { z } from 'zod';
import type { FetchLike } from './types.js';
import { backoffDelay, realSleep, redactUrl, type SleepFn, type TokenBucket } from './util.js';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export interface HttpClientOptions {
  fetch?: FetchLike;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429, 5xx and network errors. */
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Upper bound for a server-provided Retry-After delay. */
  maxRetryAfterMs?: number;
  sleep?: SleepFn;
  random?: () => number;
  /** Header values to keep out of error messages (for example API keys). */
  secrets?: string[];
  /** Largest response body accepted; larger bodies are rejected without being buffered in full. */
  maxBodyBytes?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Rate limiter consulted before every attempt, including retries. */
  limiter?: TokenBucket;
  /**
   * Overrides the client's retry count for this request. Pay-per-call APIs pass 0: a timed-out
   * attempt may still be billed, and a budget reserved for one call must not pay for several.
   */
  maxRetries?: number;
}

/**
 * JSON HTTP client with per-attempt timeouts, jittered exponential backoff on 429/5xx/network
 * errors, optional per-source rate limiting and zod validation. Error messages carry only the
 * redacted URL and status, never headers, query strings or response bodies.
 */
export class HttpClient {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: SleepFn;
  private readonly random: () => number;
  private readonly secrets: string[];
  private readonly maxBodyBytes: number;

  constructor(opts: HttpClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
    this.secrets = (opts.secrets ?? []).filter((s) => s.length >= 4);
    this.maxBodyBytes = opts.maxBodyBytes ?? 5_000_000;
  }

  private scrub(msg: string): string {
    let out = msg;
    for (const s of this.secrets) out = out.split(s).join('[redacted]');
    return out;
  }

  /** Fetches and parses JSON, then validates it. Throws HttpError or SchemaError. */
  async json<T>(url: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, req: RequestOptions = {}): Promise<T> {
    const raw = await this.rawJson(url, req);
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new SchemaError(
        `response from ${this.scrub(redactUrl(url))} failed validation: ${parsed.error.issues.length} issue(s)`,
      );
    }
    return parsed.data;
  }

  /** Fetches and parses JSON without validation (callers validate per record). */
  async rawJson(url: string, req: RequestOptions = {}): Promise<unknown> {
    // Secrets are scrubbed from the URL too: some providers put the key in the path.
    const safeUrl = this.scrub(redactUrl(url));
    let lastErr: HttpError | null = null;
    const maxRetries = req.maxRetries !== undefined ? Math.max(0, Math.floor(req.maxRetries)) : this.maxRetries;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (req.limiter) await req.limiter.take();
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: req.method ?? 'GET',
          headers: { accept: 'application/json', ...(req.headers ?? {}) },
          body: req.body,
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : 'Error';
        lastErr = new HttpError(this.scrub(`request to ${safeUrl} failed: ${name}`), null, true);
        if (attempt < maxRetries) {
          await this.sleep(backoffDelay(attempt, this.baseBackoffMs, this.maxBackoffMs, this.random));
          continue;
        }
        throw lastErr;
      }

      if (res.ok) return this.readJson(res, safeUrl);

      const retryable = res.status === 429 || res.status >= 500;
      // Drain the body so the connection can be reused; never surface it.
      await res.text().catch(() => undefined);
      lastErr = new HttpError(`request to ${safeUrl} returned HTTP ${res.status}`, res.status, retryable);
      if (!retryable || attempt >= maxRetries) throw lastErr;
      let delay = backoffDelay(attempt, this.baseBackoffMs, this.maxBackoffMs, this.random);
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfter !== null) delay = Math.max(delay, Math.min(retryAfter, this.maxRetryAfterMs));
      await this.sleep(delay);
    }
    throw lastErr ?? new HttpError(`request to ${safeUrl} failed`, null, false);
  }

  /** Reads and parses a JSON body, refusing bodies larger than `maxBodyBytes`. */
  private async readJson(res: Response, safeUrl: string): Promise<unknown> {
    const tooLarge = () => new SchemaError(`response from ${safeUrl} exceeded ${this.maxBodyBytes} bytes`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw tooLarge();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw tooLarge();
        }
        chunks.push(value);
      }
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SchemaError(`response from ${safeUrl} was not valid JSON`);
    }
  }
}

function parseRetryAfter(v: string | null): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}
