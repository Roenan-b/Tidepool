import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { createLogger, isSensitiveKey, redactString } from './log.js';

const base = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  ENGINE_API_TOKEN: 'a'.repeat(64),
};

describe('loadConfig', () => {
  it('loads defaults in paper mode', () => {
    const c = loadConfig(base);
    expect(c.liveTradingEnabled).toBe(false);
    expect(c.api).toEqual({ host: '127.0.0.1', port: 7070, token: 'a'.repeat(64) });
    expect(c.paperStartingLamports).toBe(10_000_000_000n);
    expect(c.signer).toBeNull();
    expect(c.telegram).toBeNull();
    expect(c.risk.reconcileToleranceLamports).toBe(0n);
    expect(c.solana.landingMethod).toBe('rpc');
  });

  it('enables live only for the exact string "true"', () => {
    for (const v of ['TRUE', '1', 'yes', ' true', 'true ']) expect(loadConfig({ ...base, LIVE_TRADING_ENABLED: v }).liveTradingEnabled).toBe(false);
    const live = loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true', RESERVATION_TICKET_SECRET: 's'.repeat(32), SIGNER_URL: 'http://127.0.0.1:7071', SIGNER_API_TOKEN: 't'.repeat(40) });
    expect(live.liveTradingEnabled).toBe(true);
    expect(live.signer?.url).toBe('http://127.0.0.1:7071');
  });

  it('requires signer settings and a long ticket secret in live mode', () => {
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true', RESERVATION_TICKET_SECRET: 'short', SIGNER_URL: 'http://127.0.0.1:7071', SIGNER_API_TOKEN: 't'.repeat(40) })).toThrow(/RESERVATION_TICKET_SECRET/);
    expect(() => loadConfig({ ...base, LIVE_TRADING_ENABLED: 'true', RESERVATION_TICKET_SECRET: 's'.repeat(32) })).toThrow(/SIGNER_URL/);
  });

  it('rejects placeholders, short tokens, non-loopback hosts, and never echoes values', () => {
    let err: unknown;
    try {
      loadConfig({ ...base, ENGINE_API_TOKEN: 'replace-with-64-hex-chars-aaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).not.toContain('replace-with-64');
    expect(() => loadConfig({ ...base, ENGINE_API_TOKEN: 'short' })).toThrow(/ENGINE_API_TOKEN/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/ENGINE_API_TOKEN/);
    expect(() => loadConfig({ ...base, ENGINE_API_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: '1:abc' })).toThrow(/TELEGRAM/);
  });

  it('treats empty strings as unset and parses lists', () => {
    const c = loadConfig({ ...base, HELIUS_API_KEY: '', X_CURATED_USER_IDS: '123, 456,bad,', SIGNER_URL: '', ENGINE_API_PORT: '' });
    expect(c.solana.heliusApiKey).toBeNull();
    expect(c.social.xCuratedUserIds).toEqual(['123', '456']);
    expect(c.api.port).toBe(7070);
  });
});

describe('logger redaction', () => {
  it('redacts credential-like fields at any depth but keeps trading fields', () => {
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger({ destination: dest });
    log.info({ cfg: { signer: { apiToken: 'SECRET1' }, ticketSecret: 'SECRET2', nested: [{ passphrase: 'SECRET3' }] }, tokenAmount: '42', idempotencyKey: 'k1', ticket: { mac: 'SECRET4' }, headers: { authorization: 'Bearer SECRET5' } }, 'x');
    const out = lines.join('');
    for (const s of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'SECRET5']) expect(out).not.toContain(s);
    expect(out).toContain('"tokenAmount":"42"');
    expect(out).toContain('"idempotencyKey":"k1"');
    expect(isSensitiveKey('HELIUS_API_KEY')).toBe(true);
    expect(isSensitiveKey('publicKey')).toBe(false);
  });
});

describe('review regressions', () => {
  it('rejects a SIGNER_URL that would carry the signer token in clear text to another host', () => {
    const signer = { SIGNER_API_TOKEN: 't'.repeat(40) };
    expect(() => loadConfig({ ...base, ...signer, SIGNER_URL: 'http://10.0.0.5:7071' })).toThrow(/SIGNER_URL must use https/);
    expect(() => loadConfig({ ...base, ...signer, SIGNER_URL: 'ftp://127.0.0.1/x' })).toThrow(/SIGNER_URL must use https/);
    expect(loadConfig({ ...base, ...signer, SIGNER_URL: 'https://signer.internal:7071' }).signer?.url).toBe('https://signer.internal:7071');
    expect(loadConfig({ ...base, ...signer, SIGNER_URL: 'http://[::1]:7071' }).signer?.url).toBe('http://[::1]:7071');
    expect(loadConfig({ ...base, ...signer, SIGNER_URL: 'http://localhost:7071' }).signer?.url).toBe('http://localhost:7071');
  });

  it('redacts credentials embedded in URL values and connection-string fields', () => {
    const lines: string[] = [];
    const dest = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
    const log = createLogger({ destination: dest });
    log.info({
      databaseUrl: 'postgres://memebot:PGPASS1@127.0.0.1:5432/memebot',
      rpc: 'https://mainnet.helius-rpc.com/?api-key=HELIUSKEY2&x=1',
      ws: 'wss://atlas.helius-rpc.com?api_key=HELIUSKEY3',
      note: 'connect to postgresql://u:PGPASS4@db/x failed',
      tg: 'https://api.telegram.org/bot123456:BOTTOKEN5abcdefghijklmnop/sendMessage',
      mint: 'So11111111111111111111111111111111111111112',
    }, 'x');
    const out = lines.join('');
    for (const s of ['PGPASS1', 'HELIUSKEY2', 'HELIUSKEY3', 'PGPASS4', 'BOTTOKEN5']) expect(out).not.toContain(s);
    expect(out).toContain('So11111111111111111111111111111111111111112');
    expect(out).toContain('x=1');
    expect(redactString('plain text with no url')).toBe('plain text with no url');
    expect(isSensitiveKey('connectionString')).toBe(true);
  });
});
