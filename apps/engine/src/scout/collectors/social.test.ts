import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { HttpClient } from '../http.js';
import { MemorySignalSink } from '../sink.js';
import { HeliusDasHolderCounter, HolderStatsCollector } from './holders.js';
import { LunarCrushCollector, normalizeSentiment } from './lunarcrush.js';
import { extractCashtags, extractMints, XCuratedCollector } from './x.js';

const MINT = new PublicKey(Buffer.alloc(32, 31)).toBase58();
const OTHER = new PublicKey(Buffer.alloc(32, 32)).toBase58();
const NOW = new Date('2026-11-22T12:00:00Z');

describe('X helpers', () => {
  it('extracts canonical mint addresses and cashtags', () => {
    const text = `New: ${MINT} and $dog $WIF_2 plus 0OIlnotbase58aaaaaaaaaaaaaaaaaaaaaaaaaa and short1234`;
    expect(extractMints(text)).toEqual([MINT]);
    expect(extractCashtags(text, ['Bonk'])).toEqual(['BONK', 'DOG', 'WIF_2']);
  });
});

function xResponse(n: number) {
  return {
    data: Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), text: i === 0 ? `look at ${MINT}` : i === 1 ? 'buying $DOG' : 'gm', created_at: NOW.toISOString() })),
    includes: { users: [{ id: '42', created_at: '2020-01-01T00:00:00Z', verified: false, public_metrics: { followers_count: 5000, following_count: 100 } }] },
    meta: { newest_id: String(1000 + n - 1), result_count: n },
  };
}

describe('XCuratedCollector', () => {
  it('stays disabled without a token or user ids', () => {
    expect(new XCuratedCollector({ sink: new MemorySignalSink(), userIds: ['42'], maxReadsPerHour: 100 }).enabled).toBe(false);
    expect(new XCuratedCollector({ sink: new MemorySignalSink(), bearerToken: 't', userIds: ['@bad'], maxReadsPerHour: 100 }).enabled).toBe(false);
  });

  it('enforces the hourly read budget as a hard cap', async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      const max = Number(new URL(url).searchParams.get('max_results'));
      return new Response(JSON.stringify(xResponse(max)), { status: 200 });
    };
    let t = NOW.getTime();
    const sink = new MemorySignalSink();
    const c = new XCuratedCollector({
      sink,
      bearerToken: 'tok',
      userIds: ['42'],
      maxReadsPerHour: 25,
      maxResultsPerCall: 10,
      watchedSymbols: () => new Map([['DOG', OTHER]]),
      http: new HttpClient({ fetch }),
      now: () => new Date(t),
    });
    expect(await c.pollOnce()).toBe(10); // reserves 11
    expect(await c.pollOnce()).toBe(10); // reserves 11, 3 left
    expect(await c.pollOnce()).toBe(0); // fewer than 5 + 1 remain
    expect(urls).toHaveLength(2);
    expect(c.remainingReads).toBe(3);
    expect(new URL(urls[1]!).searchParams.get('since_id')).toBe('1009');
    t += 3_600_001;
    expect(c.remainingReads).toBe(25);

    const mints = sink.events.filter((e) => e.mint).map((e) => [e.mint, e.payload.matchedBy]);
    expect(mints).toContainEqual([MINT, 'mint']);
    expect(mints).toContainEqual([OTHER, 'cashtag']);
    const q = sink.events[0]!.payload.quality as Record<string, unknown>;
    expect(q.followers).toBe(5000);
    expect(q.accountAgeDays as number).toBeGreaterThan(2000);
  });
});

describe('paid sources never retry a budgeted request', () => {
  const failing = () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response('{}', { status: 503 });
    };
    return { fetch, calls: () => calls };
  };

  it('X: one request per reservation even when the injected client retries', async () => {
    const f = failing();
    const c = new XCuratedCollector({
      sink: new MemorySignalSink(),
      bearerToken: 'tok',
      userIds: ['42'],
      maxReadsPerHour: 11,
      maxResultsPerCall: 10,
      http: new HttpClient({ fetch: f.fetch, maxRetries: 3, sleep: async () => undefined }),
      now: () => NOW,
    });
    await expect(c.pollOnce()).rejects.toThrow(/503/);
    expect(f.calls()).toBe(1);
    expect(c.remainingReads).toBe(0);
  });

  it('LunarCrush: one request per budget unit even when the injected client retries', async () => {
    const f = failing();
    const c = new LunarCrushCollector({
      sink: new MemorySignalSink(),
      apiKey: 'key',
      watched: () => [{ mint: MINT, symbol: 'DOG' }],
      maxRequestsPerHour: 1,
      http: new HttpClient({ fetch: f.fetch, maxRetries: 3, sleep: async () => undefined }),
      now: () => NOW,
    });
    await expect(c.pollOnce()).rejects.toThrow(/503/);
    expect(f.calls()).toBe(1);
  });
});

describe('LunarCrushCollector', () => {
  it('maps metrics, honors the request budget and skips symbol mismatches', async () => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const sym = url.includes('/coins/dog/') ? 'DOG' : 'NOTCAT';
      return new Response(JSON.stringify({ data: { symbol: sym, sentiment: 75, social_volume_24h: 2880, extra: true } }), { status: 200 });
    };
    const sink = new MemorySignalSink();
    const c = new LunarCrushCollector({
      sink,
      apiKey: 'key',
      watched: () => [
        { mint: MINT, symbol: 'DOG' },
        { mint: OTHER, symbol: 'CAT' },
      ],
      maxRequestsPerHour: 2,
      http: new HttpClient({ fetch }),
      now: () => NOW,
    });
    expect(await c.pollOnce()).toBe(true);
    expect(await c.pollOnce()).toBe(true);
    expect(await c.pollOnce()).toBe(false);
    expect(calls).toHaveLength(2);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.payload).toMatchObject({ mentionsPerMinute: 2, sentiment: 0.5, symbolMatched: true });
    expect(new LunarCrushCollector({ sink, watched: () => [] }).enabled).toBe(false);
    expect(normalizeSentiment(0)).toBe(-1);
  });
});

describe('Holder counts', () => {
  it('counts distinct non-zero owners across pages and reports a capped lower bound', async () => {
    const bodies: unknown[] = [];
    const fetch = async (_url: string, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body));
      bodies.push(req);
      const page = req.params.page as number;
      const accounts = Array.from({ length: 2 }, (_, i) => ({ owner: `o${page}-${i}`, amount: i === 0 && page === 1 ? 0 : 5 }));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { total: 2, limit: 2, page, token_accounts: accounts } }), { status: 200 });
    };
    const counter = new HeliusDasHolderCounter({ rpcUrl: 'https://rpc.example.com/?api-key=k', maxPages: 2, pageSize: 2, http: new HttpClient({ fetch }) });
    expect(await counter.holderCount(MINT)).toEqual({ count: 3, capped: true });
    expect(bodies[0]).toMatchObject({ method: 'getTokenAccounts', params: { mint: MINT, page: 1, limit: 2 } });
    expect(await counter.holderCount('bad')).toBeNull();
  });

  it('emits holder snapshots for watched mints', async () => {
    const sink = new MemorySignalSink();
    const c = new HolderStatsCollector({ sink, provider: { holderCount: async () => ({ count: 12, capped: false }) }, watched: () => [MINT, OTHER], now: () => NOW });
    await c.pollOnce();
    expect(sink.events.map((e) => [e.mint, e.kind, e.payload.holderCount])).toEqual([
      [MINT, 'holder_snapshot', 12],
      [OTHER, 'holder_snapshot', 12],
    ]);
  });
});
