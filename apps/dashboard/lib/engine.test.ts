import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { engineErrorMessage, engineRequest } from './engine.js';

const token = 'f'.repeat(64);
const config = loadConfig({ ENGINE_API_TOKEN: token, ENGINE_URL: 'http://127.0.0.1:7070' });
const viewer = { role: 'owner' as const, username: 'jake' };

describe('engineRequest', () => {
  it('sends the bearer token, actor headers and JSON body to the engine', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fake = async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const r = await engineRequest({ method: 'POST', path: '/control/start', body: { preset: 'balanced' }, viewer }, { fetch: fake, config });
    expect(r).toEqual({ ok: true, data: { ok: true } });
    expect(seen!.url).toBe('http://127.0.0.1:7070/control/start');
    const h = seen!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${token}`);
    expect(h['X-Actor-Role']).toBe('owner');
    expect(seen!.init.body).toBe('{"preset":"balanced"}');
    expect(seen!.init.redirect).toBe('error');
  });

  it('appends validated query strings', async () => {
    let url = '';
    await engineRequest(
      { method: 'GET', path: '/events', query: new URLSearchParams('limit=5'), viewer },
      { fetch: async (u) => { url = u; return new Response('[]'); }, config },
    );
    expect(url).toBe('http://127.0.0.1:7070/events?limit=5');
  });

  it('maps network failures to a friendly unreachable error', async () => {
    const r = await engineRequest({ method: 'GET', path: '/status', viewer }, { fetch: async () => { throw new TypeError('fetch failed'); }, config });
    expect(r).toMatchObject({ ok: false, status: 502, error: 'engine_unreachable' });
  });

  it('passes short 4xx messages and hides 5xx details', async () => {
    const r4 = await engineRequest({ method: 'POST', path: '/control/start', viewer }, { fetch: async () => new Response(JSON.stringify({ error: 'halted', message: 'Engine is halted' }), { status: 409 }), config });
    expect(r4).toMatchObject({ ok: false, status: 409, error: 'halted', message: 'Engine is halted' });
    const r5 = await engineRequest({ method: 'GET', path: '/status', viewer }, { fetch: async () => new Response(JSON.stringify({ message: 'stack trace at db.ts:42' }), { status: 500 }), config });
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.message).not.toContain('stack');
  });

  it('never forwards to the engine without a token', async () => {
    const r = await engineRequest({ method: 'GET', path: '/status', viewer }, { fetch: async () => { throw new Error('should not be called'); }, config: loadConfig({}) });
    expect(r).toMatchObject({ ok: false, error: 'engine_not_configured' });
  });

  it('refuses an oversized engine response without buffering all of it', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(chunk);
      },
    });
    const r = await engineRequest({ method: 'GET', path: '/status', viewer }, { fetch: async () => new Response(endless), config });
    expect(r).toMatchObject({ ok: false, error: 'engine_response_too_large' });
    expect(pulled).toBeLessThan(40); // 2 MiB limit / 64 KiB chunks = 32, plus a small read-ahead
  });

  it('rejects non-JSON responses', async () => {
    const r = await engineRequest({ method: 'GET', path: '/status', viewer }, { fetch: async () => new Response('<html>'), config });
    expect(r).toMatchObject({ ok: false, error: 'engine_bad_response' });
  });
});

describe('engineErrorMessage', () => {
  it('strips control characters and bounds length', () => {
    const m = engineErrorMessage(400, { error: 'bad\u0000', message: 'x'.repeat(1000) });
    expect(m.error).toBe('bad');
    expect(m.message.length).toBe(300);
  });
});
