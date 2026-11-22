import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpClient, HttpError, SchemaError } from './http.js';
import { TokenBucket } from './util.js';

function scripted(responses: (Response | Error)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('no scripted response');
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('HttpClient', () => {
  const schema = z.object({ ok: z.boolean() });

  it('retries on 429 and 5xx with backoff, then succeeds', async () => {
    const s = scripted([json({}, 429), json({}, 503), json({ ok: true })]);
    const sleeps: number[] = [];
    const c = new HttpClient({
      fetch: s.fetch,
      maxRetries: 3,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });
    await expect(c.json('https://api.example.com/x', schema)).resolves.toEqual({ ok: true });
    expect(s.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it('honors Retry-After up to the cap', async () => {
    const s = scripted([json({}, 429, { 'retry-after': '7' }), json({ ok: true })]);
    const sleeps: number[] = [];
    const c = new HttpClient({ fetch: s.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    await c.json('https://api.example.com/x', schema);
    expect(sleeps).toEqual([7_000]);
  });

  it('does not retry other 4xx errors', async () => {
    const s = scripted([json({}, 404)]);
    const c = new HttpClient({ fetch: s.fetch, sleep: async () => undefined });
    await expect(c.json('https://api.example.com/x', schema)).rejects.toMatchObject({ status: 404, retryable: false });
    expect(s.calls).toHaveLength(1);
  });

  it('gives up after maxRetries', async () => {
    const s = scripted([json({}, 500), json({}, 500), json({}, 500)]);
    const c = new HttpClient({ fetch: s.fetch, maxRetries: 2, sleep: async () => undefined });
    await expect(c.json('https://api.example.com/x', schema)).rejects.toBeInstanceOf(HttpError);
    expect(s.calls).toHaveLength(3);
  });

  it('retries network errors and never leaks query-string keys or configured secrets', async () => {
    const s = scripted([new TypeError('fetch failed SECRETKEY'), new TypeError('again')]);
    const c = new HttpClient({ fetch: s.fetch, maxRetries: 1, sleep: async () => undefined, secrets: ['SECRETKEY'] });
    const err = await c.json('https://rpc.example.com/?api-key=SECRETKEY', schema).catch((e: Error) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as Error).message).not.toContain('SECRETKEY');
    expect((err as Error).message).toContain('https://rpc.example.com/');
  });

  it('raises SchemaError for invalid bodies', async () => {
    const s = scripted([json({ ok: 'yes' })]);
    const c = new HttpClient({ fetch: s.fetch });
    await expect(c.json('https://api.example.com/x', schema)).rejects.toBeInstanceOf(SchemaError);
  });

  it('lets a single request opt out of retries (pay-per-call APIs)', async () => {
    const s = scripted([json({}, 503), json({ ok: true })]);
    const c = new HttpClient({ fetch: s.fetch, maxRetries: 3, sleep: async () => undefined });
    await expect(c.json('https://api.example.com/x', schema, { maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
    expect(s.calls).toHaveLength(1);
  });

  it('rejects oversized bodies, declared or streamed, and keeps secrets out of status errors', async () => {
    const big = JSON.stringify({ ok: true, pad: 'x'.repeat(2_000) });
    const declared = scripted([new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })]);
    const c1 = new HttpClient({ fetch: declared.fetch, maxBodyBytes: 1_000 });
    await expect(c1.json('https://api.example.com/x', schema)).rejects.toThrow(/exceeded 1000 bytes/);
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        for (let i = 0; i < 5; i++) ctrl.enqueue(new TextEncoder().encode('x'.repeat(400)));
        ctrl.close();
      },
    });
    const streamed = scripted([new Response(stream, { status: 200 })]);
    const c2 = new HttpClient({ fetch: streamed.fetch, maxBodyBytes: 1_000 });
    await expect(c2.json('https://api.example.com/x', schema)).rejects.toBeInstanceOf(SchemaError);
    const small = scripted([json({ ok: true })]);
    await expect(
      new HttpClient({ fetch: small.fetch, maxBodyBytes: 1_000 }).json('https://api.example.com/x', schema),
    ).resolves.toEqual({ ok: true });

    const denied = scripted([json({}, 401)]);
    const c3 = new HttpClient({ fetch: denied.fetch, secrets: ['PATHSECRET'] });
    const err = await c3.json('https://api.example.com/PATHSECRET/x', schema).catch((e: Error) => e);
    expect((err as Error).message).not.toContain('PATHSECRET');
  });

  it('consults the rate limiter before every attempt', async () => {
    let t = 0;
    const limiter = new TokenBucket(
      1,
      1,
      () => t,
      async (ms) => void (t += ms),
    );
    const s = scripted([json({}, 429), json({ ok: true })]);
    const c = new HttpClient({ fetch: s.fetch, sleep: async () => undefined });
    await c.json('https://api.example.com/x', schema, { limiter });
    expect(t).toBeGreaterThanOrEqual(1_000);
  });
});
