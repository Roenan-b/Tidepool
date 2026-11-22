import { describe, expect, it } from 'vitest';
import { buildCsp } from '../middleware.js';
import { parseArgs } from '../scripts/createUser.js';
import { MAX_BODY_BYTES, parseJsonText, readJsonBody } from './http.js';
import { readBoundedText } from './bounded.js';
import { demoHostAllowed } from './auth/server.js';

describe('content security policy', () => {
  it('uses a nonce, forbids framing and omits unsafe-eval in production', () => {
    const csp = buildCsp('abc123', false);
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
    expect(buildCsp('abc123', true)).toContain("'unsafe-eval'");
  });
});

describe('createUser argument parsing', () => {
  it('parses create with role', () => {
    expect(parseArgs(['create', '--username', 'jake', '--role', 'owner'])).toEqual({
      command: 'create',
      username: 'jake',
      role: 'owner',
    });
  });
  it('refuses passwords in argv and bad input', () => {
    expect(() => parseArgs(['create', '--username', 'jake', '--role', 'owner', '--password', 'x'])).toThrow(/stdin/);
    expect(() => parseArgs(['create', '--username', 'jake'])).toThrow(/role/);
    expect(() => parseArgs(['create', '--username', 'ja ke', '--role', 'owner'])).toThrow();
    expect(() => parseArgs(['drop', '--username', 'jake'])).toThrow(/usage/);
  });
});

describe('request helpers', () => {
  it('bounds and parses JSON bodies', () => {
    expect(parseJsonText('')).toEqual({ ok: true, value: {} });
    expect(parseJsonText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonText('{bad').ok).toBe(false);
    expect(parseJsonText(`"${'x'.repeat(9000)}"`).ok).toBe(false);
  });
  it('demo mode answers loopback hosts only', () => {
    expect(demoHostAllowed('127.0.0.1:3100')).toBe(true);
    expect(demoHostAllowed('localhost')).toBe(true);
    expect(demoHostAllowed('[::1]:3000')).toBe(true);
    expect(demoHostAllowed('dash.example.test')).toBe(false);
    expect(demoHostAllowed('127.0.0.1.evil.test')).toBe(false);
    expect(demoHostAllowed(null)).toBe(false);
  });
});

function chunkedRequest(chunks: string[], headers: Record<string, string> = { 'content-type': 'application/json' }) {
  let pulled = 0;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[pulled++];
      if (next === undefined) controller.close();
      else controller.enqueue(enc.encode(next));
    },
  });
  return { req: { headers: new Headers(headers), body }, pulledCount: () => pulled };
}

describe('bounded body reading', () => {
  it('stops reading a chunked body without Content-Length once it passes the limit', async () => {
    // 1000 chunks of 4 KiB (about 4 MB) with no Content-Length header: only the first few are read.
    const { req, pulledCount } = chunkedRequest(Array.from({ length: 1000 }, () => 'x'.repeat(4096)));
    const r = await readJsonBody(req);
    expect(r).toEqual({ ok: false, message: 'Request body is too large' });
    expect(pulledCount()).toBeLessThanOrEqual(Math.ceil(MAX_BODY_BYTES / 4096) + 2);
  });

  it('reads a small chunked JSON body and still checks the content type', async () => {
    expect(await readJsonBody(chunkedRequest(['{"a":', '1}']).req)).toEqual({ ok: true, value: { a: 1 } });
    expect((await readJsonBody(chunkedRequest(['{}'], { 'content-type': 'text/plain' }).req)).ok).toBe(false);
    expect(await readJsonBody({ headers: new Headers({ 'content-type': 'application/json' }), body: null })).toEqual({
      ok: true,
      value: {},
    });
  });

  it('decodes multi-byte UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('"\u00e9\u00e9"'.replace(/\\u00e9/g, '\u00e9'));
    const split = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 2));
        c.enqueue(bytes.slice(2));
        c.close();
      },
    });
    const r = await readBoundedText(split, 100);
    expect(r).toEqual({ ok: true, text: new TextDecoder().decode(bytes) });
  });
});
