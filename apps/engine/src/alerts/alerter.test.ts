import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { NullAlerter, TelegramAlerter, createAlerter, formatDailySummary, type Alert } from './alerter.js';

const TOKEN = '123456789:AAEexampleexampleexampleexample_123';
const alert: Alert = {
  kind: 'halt',
  severity: 'critical',
  mode: 'paper',
  title: 'Trading halted: drawdown_limit',
  body: 'details',
  haltReason: 'drawdown_limit',
};

function captureLogger() {
  const lines: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { logger: createLogger({ level: 'debug', destination: dest }), lines };
}

describe('TelegramAlerter', () => {
  it('posts plain text to sendMessage', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = new TelegramAlerter({ botToken: TOKEN, chatId: '-100123', fetchImpl });
    await t.notify(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.chat_id).toBe('-100123');
    expect(body.text).toContain('[CRITICAL]');
    expect(body.parse_mode).toBeUndefined();
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws and never logs the token on failure or timeout', async () => {
    const { logger, lines } = captureLogger();
    const failing = (async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    }) as unknown as typeof fetch;
    await new TelegramAlerter({ botToken: TOKEN, chatId: '1', fetchImpl: failing, logger }).notify(alert);
    const non200 = (async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    await new TelegramAlerter({ botToken: TOKEN, chatId: '1', fetchImpl: non200, logger }).notify(alert);
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))),
      )) as unknown as typeof fetch;
    await new TelegramAlerter({ botToken: TOKEN, chatId: '1', fetchImpl: hanging, logger, timeoutMs: 20 }).notify(
      alert,
    );
    expect(lines.length).toBe(3);
    expect(lines.join('')).not.toContain(TOKEN);
    expect(lines.join('')).not.toContain('AAEexample');
  });

  it('rejects malformed configuration and falls back to a no-op when unconfigured', async () => {
    expect(() => new TelegramAlerter({ botToken: 'nope', chatId: '1' })).toThrow();
    expect(() => new TelegramAlerter({ botToken: TOKEN, chatId: 'abc def' })).toThrow();
    expect(createAlerter({ telegram: null })).toBeInstanceOf(NullAlerter);
    expect(createAlerter({ telegram: { botToken: TOKEN, chatId: '5' } })).toBeInstanceOf(TelegramAlerter);
    await new NullAlerter().notify();
  });

  it('formats a daily summary', () => {
    const text = formatDailySummary({
      mode: 'paper',
      date: '2026-11-22',
      equityLamports: 10_250_000_000n,
      startOfDayEquityLamports: 10_000_000_000n,
      netPnlLamports: 250_000_000n,
      realizedPnlLamports: -50_000_000n,
      trades: 4,
      wins: 3,
      solUsd: 200,
      engineState: 'running',
      haltReason: null,
    });
    expect(text).toContain('Net P&L: 0.2500 SOL (~$50.00)');
    expect(text).toContain('Realized: -0.0500 SOL');
    expect(text).toContain('Trades: 4, wins: 3');
  });
});
