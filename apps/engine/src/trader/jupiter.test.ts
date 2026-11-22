import { describe, expect, it } from 'vitest';
import { JupiterClient, JupiterError, JupiterQuoteSource, JupiterSellQuoter, quoteProblem, RateLimiter, SOL_MINT, type JupiterQuote } from './jupiter.js';
import { MINT_A } from './testkit.js';

const BASE = 'https://jupiter.test.invalid';
const KEY = 'test-api-key-not-real';

function quoteBody(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL_MINT, inAmount: '1000000000', outputMint: MINT_A, outAmount: '500000000000', otherAmountThreshold: '495000000000',
    swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0.0042',
    routePlan: [{ swapInfo: { ammKey: MINT_A, label: 'Raydium', inputMint: SOL_MINT, outputMint: MINT_A, inAmount: '1000000000', outAmount: '500000000000', feeAmount: '2500000', feeMint: SOL_MINT }, percent: 100 }],
    contextSlot: 1, timeTaken: 0.01, ...over,
  } as JupiterQuote;
}

type Call = { url: string; init: RequestInit };
function fakeFetch(responder: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    return responder(c);
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof JupiterClient>[0]> = {}) {
  return new JupiterClient({ baseUrl: BASE, apiKey: KEY, fetch: fetchFn, minIntervalMs: 0, ...extra });
}

describe('JupiterClient.quote', () => {
  it('sends the documented query parameters and the api key header', async () => {
    const f = fakeFetch(() => json(quoteBody()));
    const q = await client(f.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 });
    expect(q.outAmount).toBe('500000000000');
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe('/swap/v1/quote');
    expect(Object.fromEntries(u.searchParams)).toEqual({ inputMint: SOL_MINT, outputMint: MINT_A, amount: '1000000000', slippageBps: '100', restrictIntermediateTokens: 'true' });
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('omits the api key header when none is configured', async () => {
    const f = fakeFetch(() => json(quoteBody()));
    await new JupiterClient({ baseUrl: BASE, fetch: f.fn, minIntervalMs: 0 }).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 });
    expect((f.calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBeUndefined();
  });

  it('rejects malformed responses', async () => {
    const f = fakeFetch(() => json({ ...quoteBody(), outAmount: '-5' }));
    await expect(client(f.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'invalid_response' });
    const g = fakeFetch(() => new Response('not json', { status: 200 }));
    await expect(client(g.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a quote that does not match the request', async () => {
    const f = fakeFetch(() => json(quoteBody({ inAmount: '999' })));
    await expect(client(f.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('maps 429, no-route and other HTTP errors without leaking the api key', async () => {
    const r429 = fakeFetch(() => json({ error: 'slow down' }, 429));
    await expect(client(r429.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'rate_limited', status: 429 });
    const noRoute = fakeFetch(() => json({ error: 'Could not find any route', errorCode: 'COULD_NOT_FIND_ANY_ROUTE' }, 400));
    await expect(client(noRoute.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'no_route' });
    const r500 = fakeFetch(() => json({ error: 'boom' }, 500));
    const err = await client(r500.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1n, slippageBps: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JupiterError);
    expect((err as JupiterError).kind).toBe('http');
    expect(String((err as Error).message)).not.toContain(KEY);
  });

  it('times out', async () => {
    const f = fakeFetch((c) => new Promise<Response>((_res, rej) => {
      c.init.signal?.addEventListener('abort', () => rej(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
    }));
    await expect(client(f.fn, { timeoutMs: 20 }).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('maps network failures', async () => {
    const f = fakeFetch(() => { throw new TypeError('fetch failed'); });
    await expect(client(f.fn).quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'network' });
  });

  it('validates inputs before any request', async () => {
    const f = fakeFetch(() => json(quoteBody()));
    const c = client(f.fn);
    await expect(c.quote({ inputMint: 'bad', outputMint: MINT_A, amount: 1n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'invalid_request' });
    await expect(c.quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 0n, slippageBps: 100 })).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a non-https base URL', () => {
    expect(() => new JupiterClient({ baseUrl: 'http://example.com' })).toThrow(/https/);
  });
});

describe('JupiterClient.swapInstructions', () => {
  const ix = { programId: MINT_A, accounts: [{ pubkey: MINT_A, isSigner: true, isWritable: true }], data: 'AQID' };
  it('POSTs the quote and settings and validates the instruction set', async () => {
    const f = fakeFetch(() => json({ computeBudgetInstructions: [ix], setupInstructions: [], swapInstruction: ix, cleanupInstruction: null, addressLookupTableAddresses: [MINT_A] }));
    const r = await client(f.fn).swapInstructions({ quoteResponse: quoteBody(), userPublicKey: MINT_A, prioritizationFeeLamports: 10_000 });
    expect(r.addressLookupTableAddresses).toEqual([MINT_A]);
    expect(new URL(f.calls[0]!.url).pathname).toBe('/swap/v1/swap-instructions');
    expect(f.calls[0]!.init.method).toBe('POST');
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({ userPublicKey: MINT_A, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 10_000 });
    expect(body.quoteResponse.contextSlot).toBe(1); // unknown fields preserved
  });

  it('rejects bad instruction data and error bodies', async () => {
    const bad = fakeFetch(() => json({ computeBudgetInstructions: [], setupInstructions: [], swapInstruction: { ...ix, data: '%%%' }, addressLookupTableAddresses: [] }));
    await expect(client(bad.fn).swapInstructions({ quoteResponse: quoteBody(), userPublicKey: MINT_A, prioritizationFeeLamports: 0 })).rejects.toMatchObject({ kind: 'invalid_response' });
    const err = fakeFetch(() => json({ error: 'failed to build' }));
    await expect(client(err.fn).swapInstructions({ quoteResponse: quoteBody(), userPublicKey: MINT_A, prioritizationFeeLamports: 0 })).rejects.toMatchObject({ kind: 'http' });
  });
});

describe('RateLimiter', () => {
  it('spaces request starts by the interval', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter(1_000, 10, () => t, async (ms) => { sleeps.push(ms); t += ms; });
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => rl.schedule(async () => { starts.push(t); })));
    expect(starts).toEqual([0, 1000, 2000]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('rejects when the queue is full', async () => {
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });
    const rl = new RateLimiter(0, 2, () => 0, async () => undefined);
    const a = rl.schedule(() => block);
    const b = rl.schedule(() => block);
    await expect(rl.schedule(async () => 1)).rejects.toMatchObject({ kind: 'queue_full' });
    release();
    await Promise.all([a, b]);
    await expect(rl.schedule(async () => 1)).resolves.toBe(1);
  });

  it('client requests go through the limiter (1 rps default)', async () => {
    let t = 0;
    const f = fakeFetch(() => json(quoteBody()));
    const c = new JupiterClient({ baseUrl: BASE, fetch: f.fn, now: () => t, sleep: async (ms) => { t += ms; } });
    await Promise.all([0, 1].map(() => c.quote({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 })));
    expect(t).toBe(1000);
  });
});

describe('JupiterQuoteSource and JupiterSellQuoter', () => {
  it('computes buy and sell prices in lamports per raw unit, impact in percent', async () => {
    const f = fakeFetch((c) => {
      const u = new URL(c.url);
      if (u.searchParams.get('inputMint') === SOL_MINT) return json(quoteBody());
      return json(quoteBody({ inputMint: MINT_A, outputMint: SOL_MINT, inAmount: '500000000000', outAmount: '990000000', otherAmountThreshold: '980100000', routePlan: [{ swapInfo: { ammKey: MINT_A, label: 'Pump.fun', inputMint: MINT_A, outputMint: SOL_MINT, inAmount: '500000000000', outAmount: '990000000' }, percent: 100 }] }));
    });
    const src = new JupiterQuoteSource(client(f.fn));
    const buy = await src.quote(MINT_A, 'buy', 1_000_000_000n);
    expect(buy).toMatchObject({ routeOk: true, venue: 'graduated' });
    expect(buy.priceLamportsPerUnit).toBeCloseTo(0.002, 12);
    expect(buy.priceImpactPct).toBeCloseTo(0.42, 10);
    const sell = await src.quote(MINT_A, 'sell', 500_000_000_000n);
    expect(sell.priceLamportsPerUnit).toBeCloseTo(0.00198, 12);
    expect(sell.venue).toBe('bondingCurve');
  });

  it('maps no-route to routeOk false and rethrows other errors', async () => {
    const nr = fakeFetch(() => json({ error: 'no route found' }, 400));
    expect(await new JupiterQuoteSource(client(nr.fn)).quote(MINT_A, 'buy', 1n)).toMatchObject({ routeOk: false });
    const down = fakeFetch(() => json({ error: 'x' }, 503));
    await expect(new JupiterQuoteSource(client(down.fn)).quote(MINT_A, 'buy', 1n)).rejects.toBeInstanceOf(JupiterError);
  });

  it('sell ratio: healthy, honeypot (no sell route), and unknown', async () => {
    const healthy = fakeFetch((c) => new URL(c.url).searchParams.get('inputMint') === SOL_MINT
      ? json(quoteBody())
      : json(quoteBody({ inputMint: MINT_A, outputMint: SOL_MINT, inAmount: '500000000000', outAmount: '970000000', otherAmountThreshold: '960300000', routePlan: [{ swapInfo: { ammKey: MINT_A, label: 'Raydium', inputMint: MINT_A, outputMint: SOL_MINT, inAmount: '500000000000', outAmount: '970000000' }, percent: 100 }] })));
    expect(await new JupiterSellQuoter(client(healthy.fn), 100).quoteSellRatio(MINT_A, 1_000_000_000n)).toBeCloseTo(0.97, 10);

    const honeypot = fakeFetch((c) => new URL(c.url).searchParams.get('inputMint') === SOL_MINT ? json(quoteBody()) : json({ error: 'Could not find any route' }, 400));
    expect(await new JupiterSellQuoter(client(honeypot.fn), 100).quoteSellRatio(MINT_A, 1_000_000_000n)).toBe(0);

    const down = fakeFetch(() => json({ error: 'x' }, 503));
    expect(await new JupiterSellQuoter(client(down.fn)).quoteSellRatio(MINT_A, 1_000_000_000n)).toBeNull();
    expect(await new JupiterSellQuoter(client(down.fn)).quoteSellRatio('bad', 1n)).toBeNull();
  });
});

describe('quoteProblem (review regression)', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const STRAY = 'Stray1111111111111111111111111111111111111';
  const req = { inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000_000n, slippageBps: 100 };
  const leg = (inputMint: string, outputMint: string) => ({ swapInfo: { ammKey: MINT_A, inputMint, outputMint, inAmount: '1', outAmount: '1' }, percent: 100 });

  it('accepts a consistent direct or multi-hop quote', () => {
    expect(quoteProblem(quoteBody(), req)).toBeNull();
    expect(quoteProblem(quoteBody({ routePlan: [leg(SOL_MINT, USDC), leg(USDC, MINT_A)] }), req)).toBeNull();
    // Rounding: one raw unit below the exact bound is tolerated.
    expect(quoteProblem(quoteBody({ otherAmountThreshold: '494999999999' }), req)).toBeNull();
  });

  it('rejects quotes that would let the swap fill with a weaker minimum out', () => {
    expect(quoteProblem(quoteBody({ otherAmountThreshold: '0' }), req)).toMatch(/slippage bound/);
    expect(quoteProblem(quoteBody({ otherAmountThreshold: '494999999998' }), req)).toMatch(/slippage bound/);
    expect(quoteProblem(quoteBody({ otherAmountThreshold: '500000000001' }), req)).toMatch(/above outAmount/);
    expect(quoteProblem(quoteBody({ slippageBps: 300, otherAmountThreshold: '485000000000' }), req)).toMatch(/slippageBps/);
    expect(quoteProblem(quoteBody({ swapMode: 'ExactOut' }), req)).toMatch(/not ExactIn/);
    expect(quoteProblem(quoteBody({ outAmount: '0', otherAmountThreshold: '0' }), req)).toMatch(/zero/);
  });

  it('rejects routes into or out of unexpected mints', () => {
    expect(quoteProblem(quoteBody({ routePlan: [leg(SOL_MINT, STRAY)] }), req)).toMatch(/end at the output/);
    expect(quoteProblem(quoteBody({ routePlan: [leg(SOL_MINT, MINT_A), leg(SOL_MINT, STRAY)] }), req)).toMatch(/leads nowhere/);
    expect(quoteProblem(quoteBody({ routePlan: [leg(SOL_MINT, MINT_A), leg(STRAY, MINT_A)] }), req)).toMatch(/not reachable/);
  });

  it('the client rejects a quote with a zero threshold', async () => {
    const f = fakeFetch(() => json(quoteBody({ otherAmountThreshold: '0' })));
    await expect(client(f.fn).quote(req)).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
