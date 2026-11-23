/**
 * Jupiter swap API client (Metis "swap/v1" shape: quote + swap-instructions).
 *
 * IMPORTANT: the endpoint paths, query parameters, request fields and response fields below must be confirmed
 * against Jupiter's current API documentation before live use. Jupiter versions its APIs and has changed paths,
 * hosts, rate limits and field semantics before (for example lite-api vs api hosts, v6 vs swap/v1 paths, and
 * whether priceImpactPct is a fraction or a percentage). Every response is schema-validated, so a shape change
 * fails closed with JupiterError('invalid_response') rather than trading on misread data.
 *
 * Rate limit: the free key allows about 1 request per second, so requests are spaced by minIntervalMs and
 * queued in a bounded queue; overflow is rejected immediately rather than delaying the trading loop.
 */
import { z } from 'zod';
import type { QuoteResult, QuoteSource, Venue } from './types.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export type JupiterErrorKind =
  'timeout' | 'network' | 'http' | 'rate_limited' | 'no_route' | 'invalid_response' | 'queue_full' | 'invalid_request';

export class JupiterError extends Error {
  constructor(
    readonly kind: JupiterErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JupiterError';
  }
}

const U64 = z.string().regex(/^\d{1,20}$/);
const Pubkey = z.string().regex(BASE58);

const SwapInfo = z
  .object({
    ammKey: Pubkey,
    label: z.string().max(100).optional(),
    inputMint: Pubkey,
    outputMint: Pubkey,
    inAmount: U64,
    outAmount: U64,
    feeAmount: U64.optional(),
    feeMint: Pubkey.optional(),
  })
  .loose();

/** Quote response. passthrough() keeps unknown fields because the quote is sent back verbatim to swap-instructions. */
export const QuoteResponseSchema = z
  .object({
    inputMint: Pubkey,
    inAmount: U64,
    outputMint: Pubkey,
    outAmount: U64,
    otherAmountThreshold: U64,
    swapMode: z.enum(['ExactIn', 'ExactOut']),
    slippageBps: z.number().int().min(0).max(10_000),
    priceImpactPct: z.string().regex(/^-?\d+(\.\d+)?([eE]-?\d+)?$/),
    routePlan: z
      .array(z.object({ swapInfo: SwapInfo, percent: z.number().min(0).max(100).nullable().optional() }).loose())
      .min(1)
      .max(32),
    contextSlot: z.number().optional(),
    timeTaken: z.number().optional(),
  })
  .loose();
export type JupiterQuote = z.infer<typeof QuoteResponseSchema>;

export const InstructionSchema = z.object({
  programId: Pubkey,
  accounts: z.array(z.object({ pubkey: Pubkey, isSigner: z.boolean(), isWritable: z.boolean() })).max(128),
  data: z.string().max(20_000).regex(BASE64),
});
export type JupiterInstruction = z.infer<typeof InstructionSchema>;

export const SwapInstructionsSchema = z.object({
  tokenLedgerInstruction: InstructionSchema.nullish(),
  computeBudgetInstructions: z.array(InstructionSchema).max(8),
  setupInstructions: z.array(InstructionSchema).max(16),
  swapInstruction: InstructionSchema,
  cleanupInstruction: InstructionSchema.nullish(),
  otherInstructions: z.array(InstructionSchema).max(8).optional(),
  addressLookupTableAddresses: z.array(Pubkey).max(32),
  prioritizationFeeLamports: z.number().optional(),
  computeUnitLimit: z.number().optional(),
});
export type JupiterSwapInstructions = z.infer<typeof SwapInstructionsSchema>;

export interface JupiterClientOptions {
  baseUrl: string;
  /** Sent as the x-api-key header when set (JUPITER_API_KEY). Never logged. */
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Minimum spacing between request starts; 1000 ms matches the free key's 1 rps. */
  minIntervalMs?: number;
  /** Requests waiting for a slot beyond this are rejected with queue_full. */
  maxQueue?: number;
  maxResponseBytes?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Spaces request starts by a minimum interval with a bounded wait queue. */
export class RateLimiter {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  constructor(
    private readonly minIntervalMs: number,
    private readonly maxQueue: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending >= this.maxQueue)
      return Promise.reject(new JupiterError('queue_full', 'jupiter request queue full'));
    this.pending += 1;
    const slot = this.tail.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.tail = slot.catch(() => undefined);
    return slot.then(fn).finally(() => {
      this.pending -= 1;
    });
  }
}

export class JupiterClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly limiter: RateLimiter;

  constructor(private readonly opts: JupiterClientOptions) {
    let u: URL;
    try {
      u = new URL(opts.baseUrl);
    } catch {
      throw new Error('JUPITER_BASE_URL is not a valid URL');
    }
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'))
    ) {
      throw new Error('JUPITER_BASE_URL must use https');
    }
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxBytes = opts.maxResponseBytes ?? 2_000_000;
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 1_000, opts.maxQueue ?? 16, opts.now, opts.sleep);
  }

  /** GET {base}/swap/v1/quote */
  async quote(args: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<JupiterQuote> {
    if (!BASE58.test(args.inputMint) || !BASE58.test(args.outputMint))
      throw new JupiterError('invalid_request', 'invalid mint');
    if (args.amount <= 0n || args.amount >= 2n ** 64n) throw new JupiterError('invalid_request', 'amount out of range');
    if (!Number.isInteger(args.slippageBps) || args.slippageBps < 0 || args.slippageBps > 10_000)
      throw new JupiterError('invalid_request', 'slippageBps out of range');
    const q = new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount.toString(),
      slippageBps: String(args.slippageBps),
      restrictIntermediateTokens: 'true',
    });
    const body = await this.request('GET', `/swap/v1/quote?${q.toString()}`);
    const parsed = QuoteResponseSchema.safeParse(body);
    if (!parsed.success)
      throw new JupiterError(
        'invalid_response',
        `quote response failed validation: ${parsed.error.issues[0]?.path.join('.') ?? ''}`,
      );
    const r = parsed.data;
    const problem = quoteProblem(r, args);
    if (problem) throw new JupiterError('invalid_response', `quote does not match the request: ${problem}`);
    return r;
  }

  /** POST {base}/swap/v1/swap-instructions */
  async swapInstructions(args: {
    quoteResponse: JupiterQuote;
    userPublicKey: string;
    /** Lamports, or a Jupiter priority-fee object. Confirm the accepted shapes in the current docs. */
    prioritizationFeeLamports: number | Record<string, unknown>;
    wrapAndUnwrapSol?: boolean;
    dynamicComputeUnitLimit?: boolean;
  }): Promise<JupiterSwapInstructions> {
    if (!BASE58.test(args.userPublicKey)) throw new JupiterError('invalid_request', 'invalid userPublicKey');
    const body = await this.request('POST', '/swap/v1/swap-instructions', {
      quoteResponse: args.quoteResponse,
      userPublicKey: args.userPublicKey,
      wrapAndUnwrapSol: args.wrapAndUnwrapSol ?? true,
      dynamicComputeUnitLimit: args.dynamicComputeUnitLimit ?? true,
      prioritizationFeeLamports: args.prioritizationFeeLamports,
    });
    if (body && typeof body === 'object' && 'error' in body) {
      throw new JupiterError('http', `swap-instructions error: ${String(body.error).slice(0, 200)}`);
    }
    const parsed = SwapInstructionsSchema.safeParse(body);
    if (!parsed.success)
      throw new JupiterError(
        'invalid_response',
        `swap-instructions failed validation: ${parsed.error.issues[0]?.path.join('.') ?? ''}`,
      );
    return parsed.data;
  }

  private request(method: 'GET' | 'POST', path: string, json?: unknown): Promise<unknown> {
    return this.limiter.schedule(async () => {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (json !== undefined) headers['content-type'] = 'application/json';
      if (this.opts.apiKey) headers['x-api-key'] = this.opts.apiKey;
      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, {
          method,
          headers,
          body: json === undefined ? undefined : JSON.stringify(json),
          signal: AbortSignal.timeout(this.timeoutMs),
          redirect: 'error',
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError')
          throw new JupiterError('timeout', `jupiter ${method} timed out after ${this.timeoutMs} ms`);
        throw new JupiterError('network', `jupiter ${method} network error`);
      }
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new JupiterError('network', 'failed to read jupiter response');
      }
      if (text.length > this.maxBytes) throw new JupiterError('invalid_response', 'jupiter response too large');
      let body: unknown = null;
      try {
        body = text.length ? JSON.parse(text) : null;
      } catch {
        if (res.ok) throw new JupiterError('invalid_response', 'jupiter response is not JSON');
      }
      if (res.status === 429) throw new JupiterError('rate_limited', 'jupiter rate limit hit', 429);
      if (!res.ok) {
        const detail =
          body && typeof body === 'object'
            ? JSON.stringify({
                error: (body as Record<string, unknown>).error,
                errorCode: (body as Record<string, unknown>).errorCode,
              }).slice(0, 200)
            : '';
        if ((res.status === 400 || res.status === 404) && /route/i.test(detail))
          throw new JupiterError('no_route', `no route: ${detail}`, res.status);
        throw new JupiterError('http', `jupiter HTTP ${res.status} ${detail}`, res.status);
      }
      return body;
    });
  }
}

/**
 * Checks that a quote answers exactly the request that was made, so a swap built from it cannot carry a
 * weaker minimum-out bound or route into an unexpected mint. Returns a problem description or null.
 *
 * - ExactIn only, with the requested input mint, output mint, input amount and slippage.
 * - outAmount > 0 and otherAmountThreshold (the minimum out the swap instruction enforces) between
 *   outAmount * (1 - slippage) (one raw unit of rounding allowed) and outAmount.
 * - Every route leg starts at the requested input or at another leg's output, ends at the requested output
 *   or at another leg's input, and at least one leg starts at the input and one ends at the output.
 */
export function quoteProblem(
  q: JupiterQuote,
  req: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number },
): string | null {
  if (q.swapMode !== 'ExactIn') return 'swapMode is not ExactIn';
  if (q.inputMint !== req.inputMint || q.outputMint !== req.outputMint) return 'mints differ';
  if (q.inAmount !== req.amount.toString()) return 'inAmount differs';
  if (q.slippageBps !== req.slippageBps) return `slippageBps ${q.slippageBps} != requested ${req.slippageBps}`;
  const out = BigInt(q.outAmount);
  const min = BigInt(q.otherAmountThreshold);
  if (out <= 0n) return 'outAmount is zero';
  if (min > out) return 'otherAmountThreshold above outAmount';
  if (min * 10_000n + 10_000n < out * BigInt(10_000 - req.slippageBps))
    return 'otherAmountThreshold below the slippage bound';
  const ins = new Set(q.routePlan.map((l) => l.swapInfo.inputMint));
  const outs = new Set(q.routePlan.map((l) => l.swapInfo.outputMint));
  if (!ins.has(req.inputMint)) return 'route does not start at the input mint';
  if (!outs.has(req.outputMint)) return 'route does not end at the output mint';
  for (const leg of q.routePlan) {
    const { inputMint, outputMint } = leg.swapInfo;
    if (inputMint !== req.inputMint && !outs.has(inputMint)) return `route leg input ${inputMint} is not reachable`;
    if (outputMint !== req.outputMint && !ins.has(outputMint)) return `route leg output ${outputMint} leads nowhere`;
  }
  return null;
}

/**
 * Converts Jupiter's priceImpactPct string to percent. Assumes the field is a fraction (0.01 = 1%),
 * which is how Jupiter's own UI has treated it; confirm against current docs before live use.
 */
export function priceImpactPercent(q: JupiterQuote): number {
  const v = Math.abs(Number(q.priceImpactPct));
  return Number.isFinite(v) ? v * 100 : Number.POSITIVE_INFINITY;
}

/** Labels that indicate the pump.fun bonding curve (pre-graduation). Unverified naming; confirm against live routes. */
export function venueFromQuote(q: JupiterQuote): Venue {
  return q.routePlan.some((r) => /^pump\.?fun$/i.test((r.swapInfo.label ?? '').trim())) ? 'bondingCurve' : 'graduated';
}

/** Quote source for PaperBroker backed by live Jupiter quotes. */
export class JupiterQuoteSource implements QuoteSource {
  constructor(
    private readonly client: Pick<JupiterClient, 'quote'>,
    private readonly slippageBps = 100,
  ) {}

  async quote(mint: string, side: 'buy' | 'sell', amount: bigint): Promise<QuoteResult> {
    const [inputMint, outputMint] = side === 'buy' ? [SOL_MINT, mint] : [mint, SOL_MINT];
    let q: JupiterQuote;
    try {
      q = await this.client.quote({ inputMint, outputMint, amount, slippageBps: this.slippageBps });
    } catch (err) {
      if (err instanceof JupiterError && err.kind === 'no_route')
        return { priceLamportsPerUnit: 0, priceImpactPct: 0, routeOk: false };
      throw err;
    }
    const inAmt = Number(q.inAmount);
    const outAmt = Number(q.outAmount);
    if (!(inAmt > 0) || !(outAmt > 0)) return { priceLamportsPerUnit: 0, priceImpactPct: 0, routeOk: false };
    // Buy: lamports in / tokens out. Sell: lamports out / tokens in.
    const price = side === 'buy' ? inAmt / outAmt : outAmt / inAmt;
    return {
      priceLamportsPerUnit: price,
      priceImpactPct: priceImpactPercent(q),
      routeOk: true,
      venue: venueFromQuote(q),
    };
  }
}

/** Used by the Scout's sell simulation (TokenSafety.sellSimulationRatio). */
export interface SellQuoter {
  /**
   * Round-trip check for a position of `lamportsEquivalent`: quote a buy of that size, then quote selling the
   * tokens it returns. Returns quoted SOL back / SOL in (includes both legs' venue fees and price impact, so a
   * healthy token is somewhat below 1), 0 when there is a buy route but no sell route, or null when it could
   * not be evaluated (no buy route, timeout, rate limit).
   */
  quoteSellRatio(mint: string, lamportsEquivalent: bigint): Promise<number | null>;
}

export class JupiterSellQuoter implements SellQuoter {
  constructor(
    private readonly client: Pick<JupiterClient, 'quote'>,
    private readonly slippageBps = 300,
  ) {}

  async quoteSellRatio(mint: string, lamportsEquivalent: bigint): Promise<number | null> {
    if (!BASE58.test(mint) || lamportsEquivalent <= 0n) return null;
    let buy: JupiterQuote;
    try {
      buy = await this.client.quote({
        inputMint: SOL_MINT,
        outputMint: mint,
        amount: lamportsEquivalent,
        slippageBps: this.slippageBps,
      });
    } catch {
      return null;
    }
    const tokens = BigInt(buy.outAmount);
    if (tokens <= 0n) return null;
    try {
      const sell = await this.client.quote({
        inputMint: mint,
        outputMint: SOL_MINT,
        amount: tokens,
        slippageBps: this.slippageBps,
      });
      const ratio = Number(BigInt(sell.outAmount)) / Number(lamportsEquivalent);
      return Number.isFinite(ratio) && ratio >= 0 ? ratio : null;
    } catch (err) {
      if (err instanceof JupiterError && err.kind === 'no_route') return 0;
      return null;
    }
  }
}
