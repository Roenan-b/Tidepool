import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  isMintAddress,
  LruMap,
  pgSafeString,
  redactUrl,
  sanitizeText,
  toPgJson,
  TokenBucket,
  WindowBudget,
} from './util.js';

function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills at the configured rate', () => {
    const c = fakeClock();
    const b = new TokenBucket(3, 1, c.now, c.sleep);
    expect([b.tryTake(), b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([true, true, true, false]);
    c.advance(999);
    expect(b.tryTake()).toBe(false);
    c.advance(1);
    expect(b.tryTake()).toBe(true);
  });

  it('never exceeds the documented per-minute rate over a long window', async () => {
    const c = fakeClock();
    const b = TokenBucket.perMinute(60, 2, c.now, c.sleep);
    for (let i = 0; i < 122; i++) await b.take();
    // 2 burst tokens plus 1 per second: 122 takes need at least 120 seconds.
    expect(c.now()).toBeGreaterThanOrEqual(120_000);
    expect(c.now()).toBeLessThan(121_500);
  });

  it('waits rather than failing when empty', async () => {
    const c = fakeClock();
    const b = new TokenBucket(1, 2, c.now, c.sleep);
    await b.take();
    await b.take();
    expect(c.now()).toBeGreaterThanOrEqual(500);
  });
});

describe('WindowBudget', () => {
  it('enforces a hard limit within the window and frees capacity as entries age out', () => {
    const c = fakeClock();
    const w = new WindowBudget(10, 3_600_000, c.now);
    expect(w.tryConsume(6)).toBe(true);
    expect(w.tryConsume(5)).toBe(false);
    expect(w.tryConsume(4)).toBe(true);
    expect(w.remaining()).toBe(0);
    c.advance(3_600_001);
    expect(w.remaining()).toBe(10);
  });
});

describe('LruMap', () => {
  it('evicts the least recently used key', () => {
    const evicted: string[] = [];
    const m = new LruMap<string, number>(2, (k) => evicted.push(k));
    m.set('a', 1);
    m.set('b', 2);
    m.get('a');
    m.set('c', 3);
    expect(evicted).toEqual(['b']);
    expect(m.keysMostRecentFirst()).toEqual(['c', 'a']);
  });
});

describe('helpers', () => {
  it('redacts query strings and credentials from URLs', () => {
    expect(redactUrl('https://user:pw@mainnet.example.com/v0/x?api-key=SECRET')).toBe(
      'https://mainnet.example.com/v0/x',
    );
    expect(redactUrl('not a url')).toBe('[unparseable-url]');
  });

  it('strips control and bidi characters and caps length', () => {
    expect(sanitizeText('a\u0000b‮c\n\nd', 100)).toBe('a b c d');
    expect(sanitizeText('x'.repeat(50), 10)).toHaveLength(10);
    expect(sanitizeText(42, 10)).toBe('');
  });

  it('never leaves an unpaired surrogate, even when the cap falls inside a surrogate pair', () => {
    const frogs = '\u{1F438}'.repeat(40); // 80 UTF-16 units
    const capped = sanitizeText(frogs, 63);
    expect(capped).toBe('\u{1F438}'.repeat(31));
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(sanitizeText('a\uD83Db\uDC00c', 100)).toBe('abc');
  });

  it('produces Postgres-safe strings and JSON', () => {
    expect(pgSafeString('a\u0000b\uD83D')).toBe('ab\uFFFD');
    expect(toPgJson({ t: 'x\u0000\uDC00', n: 1, nested: ['\uD800'] })).toBe(
      '{"t":"x\uFFFD","n":1,"nested":["\uFFFD"]}',
    );
  });

  it('validates canonical base58 public keys', () => {
    expect(isMintAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isMintAddress('0OIl11111111111111111111111111111111')).toBe(false);
    expect(isMintAddress('short')).toBe(false);
  });

  it('backoff stays within the exponential cap', () => {
    expect(backoffDelay(0, 100, 10_000, () => 0.999)).toBeLessThan(100);
    expect(backoffDelay(10, 100, 10_000, () => 0.999)).toBeLessThan(10_000);
    expect(backoffDelay(3, 100, 10_000, () => 0)).toBe(0);
  });
});
