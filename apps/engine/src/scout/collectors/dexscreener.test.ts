import { describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { HttpClient } from '../http.js';
import { ScoutMetrics } from '../metrics.js';
import { MemorySignalSink } from '../sink.js';
import { TokenBucket } from '../util.js';
import {
  boostSchema,
  boostToSignal,
  DexScreenerCollector,
  pairSchema,
  pairsToSnapshot,
  parseRecords,
  profileSchema,
  profileToSignal,
} from './dexscreener.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const MINT = key(7);
const PAIR = key(8);
const NOW = new Date('2026-11-22T12:00:00Z');

function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/x',
    pairAddress: PAIR,
    baseToken: { address: MINT, name: 'Dog Coin', symbol: 'DOG' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceNative: '0.0000012',
    priceUsd: '0.000250',
    txns: { m5: { buys: 40, sells: 22 }, h1: { buys: 300, sells: 200 } },
    volume: { m5: 12_000, h1: 80_000, h6: 200_000, h24: 900_000 },
    priceChange: { m5: 4.5, h1: 12 },
    liquidity: { usd: 55_000, base: 1, quote: 2 },
    fdv: 250_000,
    marketCap: 250_000,
    pairCreatedAt: NOW.getTime() - 3_600_000,
    info: {
      socials: [{ type: 'twitter', url: 'https://x.com/dog' }],
      websites: [{ url: 'https://dog.example' }, { url: 'javascript:alert(1)' }],
    },
    someNewField: { tolerated: true },
    ...overrides,
  };
}

describe('DEX Screener parsing', () => {
  it('maps a valid pair to a snapshot with numeric fields and filtered links', () => {
    const { records, stats } = parseRecords([pair()], pairSchema);
    expect(stats).toEqual({ ok: 1, skipped: 0 });
    const s = pairsToSnapshot(MINT, records, NOW)!;
    expect(s.kind).toBe('pair_snapshot');
    expect(s.payload).toMatchObject({
      pairAddress: PAIR,
      symbol: 'DOG',
      priceUsd: 0.00025,
      liquidityUsd: 55_000,
      volume5mUsd: 12_000,
      volume1hUsd: 80_000,
      priceChange5mPct: 4.5,
      buys5m: 40,
      sells5m: 22,
      boosted: false,
      pairCreatedAt: NOW.getTime() - 3_600_000,
    });
    expect(s.payload.websites).toEqual(['https://dog.example']);
  });

  it('skips and counts malformed records while keeping valid ones', () => {
    const body = [pair(), { chainId: 'solana' }, null, 'junk', pair({ baseToken: { name: 'no address' } })];
    const { records, stats } = parseRecords(body, pairSchema);
    expect(records).toHaveLength(1);
    expect(stats.skipped).toBe(4);
  });

  it('picks the deepest own-base pair and ignores other chains', () => {
    const shallow = pair({ pairAddress: key(9), liquidity: { usd: 1_000 } });
    const other = pair({ chainId: 'ethereum', liquidity: { usd: 9_999_999 } });
    const { records } = parseRecords([shallow, other, pair()], pairSchema);
    const s = pairsToSnapshot(MINT, records, NOW)!;
    expect(s.payload.pairAddress).toBe(PAIR);
    expect(s.payload.pairCount).toBe(2);
  });

  it('ignores pairs quoted in untrusted tokens or with a malformed pair address', () => {
    // A pair against an attacker-priced quote token can report any liquidity; it must not win.
    const fakeQuote = pair({
      pairAddress: key(10),
      quoteToken: { address: key(11), symbol: 'FAKE' },
      liquidity: { usd: 50_000_000 },
    });
    const noQuote = pair({ pairAddress: key(12), quoteToken: null, liquidity: { usd: 40_000_000 } });
    const badAddr = pair({ pairAddress: 'p\u0000', liquidity: { usd: 30_000_000 } });
    const { records } = parseRecords([fakeQuote, noQuote, badAddr, pair()], pairSchema);
    const s = pairsToSnapshot(MINT, records, NOW)!;
    expect(s.payload.pairAddress).toBe(PAIR);
    expect(s.payload.liquidityUsd).toBe(55_000);
    expect(pairsToSnapshot(MINT, parseRecords([fakeQuote], pairSchema).records, NOW)).toBeNull();
  });

  it('marks boosted pairs and boost events as boosted', () => {
    const { records } = parseRecords([pair({ boosts: { active: 3 } })], pairSchema);
    expect(pairsToSnapshot(MINT, records, NOW)!.payload.boosted).toBe(true);
    const b = parseRecords(
      [{ chainId: 'solana', tokenAddress: MINT, amount: 10, totalAmount: 50, description: 'buy now' }],
      boostSchema,
    );
    const ev = boostToSignal(b.records[0]!, NOW)!;
    expect(ev.kind).toBe('boost');
    expect(ev.payload.boosted).toBe(true);
  });

  it('accepts a single-object profile body and rejects non-Solana or invalid mints', () => {
    const one = parseRecords(
      {
        chainId: 'solana',
        tokenAddress: MINT,
        description: 'hi\u0000there',
        links: [{ type: 'twitter', url: 'https://x.com/a' }],
      },
      profileSchema,
    );
    expect(one.records).toHaveLength(1);
    expect(profileToSignal(one.records[0]!, NOW)!.payload.description).toBe('hi there');
    expect(profileToSignal({ chainId: 'base', tokenAddress: MINT }, NOW)).toBeNull();
    expect(profileToSignal({ chainId: 'solana', tokenAddress: '0xabc' }, NOW)).toBeNull();
  });
});

describe('DexScreenerCollector', () => {
  it('requests at most 30 addresses per call and emits one snapshot per mint with a pair', async () => {
    const mints = Array.from({ length: 45 }, (_, i) => key(i + 20));
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const addrs = url.split('/tokens/')[1]!.split(',');
      const pairs = addrs
        .slice(0, 2)
        .map((a, i) => pair({ baseToken: { address: a, symbol: 'T' }, pairAddress: key(200 + i) }));
      return new Response(JSON.stringify({ schemaVersion: '1.0.0', pairs }), { status: 200 });
    };
    const sink = new MemorySignalSink();
    const metrics = new ScoutMetrics();
    let t = 0;
    const c = new DexScreenerCollector({
      sink,
      watched: () => mints,
      http: new HttpClient({ fetch }),
      pairLimiter: new TokenBucket(
        5,
        5,
        () => t,
        async (ms) => void (t += ms),
      ),
      metrics,
      now: () => NOW,
    });
    await c.pollPairs();
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.split('/tokens/')[1]!.split(',').length <= 30)).toBe(true);
    expect(sink.events).toHaveLength(4);
    expect(metrics.counter('dexscreener.no_pair')).toBe(41);
  });

  it('retries a 429 on the profiles endpoint and emits profiles and boosts', async () => {
    let n = 0;
    const fetch = async (url: string) => {
      n++;
      if (n === 1) return new Response('{}', { status: 429 });
      if (url.includes('token-profiles'))
        return new Response(JSON.stringify([{ chainId: 'solana', tokenAddress: MINT, description: 'p' }]), {
          status: 200,
        });
      return new Response(JSON.stringify([{ chainId: 'solana', tokenAddress: MINT, amount: 5 }, { bad: true }]), {
        status: 200,
      });
    };
    const sink = new MemorySignalSink();
    const metrics = new ScoutMetrics();
    let t = 0;
    const profileLimiter = new TokenBucket(
      2,
      1,
      () => t,
      async (ms) => void (t += ms),
    );
    const c = new DexScreenerCollector({
      sink,
      watched: () => [],
      http: new HttpClient({ fetch, sleep: async () => undefined }),
      profileLimiter,
      metrics,
      now: () => NOW,
    });
    await c.pollProfilesAndBoosts();
    expect(n).toBe(3);
    expect(sink.events.map((e) => e.kind)).toEqual(['token_profile', 'boost']);
    expect(metrics.counter('dexscreener.records_skipped')).toBe(1);
    // Three requests against a 2-token bucket refilling at 1/s require waiting about one second.
    expect(t).toBeGreaterThanOrEqual(1_000);
  });

  it('never runs overlapping polls of the same endpoint when the API is slow', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let hold = true;
      const pending: (() => void)[] = [];
      const fetch = async (url: string) => {
        calls++;
        if (hold) await new Promise<void>((r) => pending.push(r));
        return new Response(JSON.stringify(url.includes('/tokens/') ? { pairs: [] } : []), { status: 200 });
      };
      const unlimited = () => new TokenBucket(1_000, 1_000);
      const c = new DexScreenerCollector({
        sink: new MemorySignalSink(),
        watched: () => [MINT],
        http: new HttpClient({ fetch }),
        profileLimiter: unlimited(),
        pairLimiter: unlimited(),
        profilesIntervalMs: 1_000,
        pairsIntervalMs: 1_000,
      });
      c.start();
      await vi.advanceTimersByTimeAsync(10_000);
      // One profiles request and one pairs request are in flight; ten ticks started nothing else.
      expect(calls).toBe(2);
      const stopped = c.stop();
      hold = false;
      while (pending.length > 0) pending.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      await stopped;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-https base URL', () => {
    expect(
      () =>
        new DexScreenerCollector({ sink: new MemorySignalSink(), watched: () => [], baseUrl: 'http://evil.example' }),
    ).toThrow();
  });
});
