import { createPublicKey, verify as edVerify } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { signTicket, type ReservationTicket } from '@tidepool/core/ticket';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base58Encode } from './base58.js';
import type { SignerConfig } from './config.js';
import { createSignerServer, MAX_BODY_BYTES, type LogRecord, type SignerServer } from './server.js';
import { SignerStateStore } from './state.js';
import { ATTACKER, buyInstructions, policyConfig, toBase64, transfer, v0 } from './test/fixtures.js';

const TICKET_SECRET = 'ticket-secret-for-tests-only-0123456789abcdef';
const API_TOKEN = 'api-token-for-tests-only-0123456789abcdef0123';
const dir = mkdtempSync(join(tmpdir(), 'signer-server-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keypair = Keypair.generate();
const wallet = keypair.publicKey;
let counter = 0;

function config(overrides: Partial<SignerConfig> = {}): SignerServerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    apiToken: API_TOKEN,
    ticketSecret: TICKET_SECRET,
    maxPerDayLamports: 250_000_000n,
    maxTicketTtlMs: 300_000,
    allowNonLoopback: false,
    policy: policyConfig(),
    ...overrides,
  };
}
type SignerServerConfig = Parameters<typeof createSignerServer>[0]['config'];

function ticket(overrides: Partial<ReservationTicket> = {}): ReservationTicket {
  const now = Date.now();
  return {
    v: 1,
    reservationId: `res-${++counter}-${now}`,
    intent: 'buy',
    mint: null,
    maxLamports: '150000000',
    maxTipLamports: '2000000',
    destination: null,
    issuedAt: now - 1_000,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

function buyTx(wrap = 100_000_000n): string {
  return toBase64(v0(wallet, buyInstructions(wallet, { wrapLamports: wrap })));
}

interface Running {
  signer: SignerServer;
  url: string;
  logs: LogRecord[];
  statePath: string;
}

async function start(statePath: string, overrides: Partial<SignerConfig> = {}): Promise<Running> {
  const logs: LogRecord[] = [];
  const signer = createSignerServer({
    config: config(overrides),
    keypair,
    state: SignerStateStore.open(statePath),
    logger: (r) => logs.push(r),
  });
  const { port } = await signer.listen();
  return { signer, url: `http://127.0.0.1:${port}`, logs, statePath };
}

async function post(url: string, body: unknown, token: string | null = API_TOKEN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/sign`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

let running: Running;
beforeEach(async () => {
  running = await start(join(dir, `state-${++counter}.json`));
});
afterEach(async () => {
  await running.signer.close();
  // No log line may ever contain the secret key in any common encoding.
  const text = JSON.stringify(running.logs);
  expect(text).not.toContain(base58Encode(keypair.secretKey));
  expect(text).not.toContain(Buffer.from(keypair.secretKey).toString('base64'));
});

describe('signer server', () => {
  it('serves health with the public key only', async () => {
    const res = await fetch(`${running.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, publicKey: wallet.toBase58() });
  });

  it('signs a valid request and returns a verifiable signature', async () => {
    const { status, json } = await post(running.url, {
      ticket: signTicket(ticket(), TICKET_SECRET),
      transactionBase64: buyTx(),
    });
    expect(status).toBe(200);
    expect(json.spendLamports).toBe('100000000');
    expect(json.tipLamports).toBe('1000000');
    const signed = VersionedTransaction.deserialize(Buffer.from(json.signedTransactionBase64 as string, 'base64'));
    expect(base58Encode(signed.signatures[0]!)).toBe(json.signature);
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(wallet.toBytes()).toString('base64url') },
      format: 'jwk',
    });
    expect(edVerify(null, signed.message.serialize(), key, signed.signatures[0]!)).toBe(true);
    expect(running.logs.some((l) => l.event === 'sign_allowed' && l.signature === json.signature)).toBe(true);
  });

  it('rejects a bad or missing bearer token with 401', async () => {
    const body = { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx() };
    expect((await post(running.url, body, 'wrong-token')).status).toBe(401);
    expect((await post(running.url, body, null)).status).toBe(401);
    expect((await post(running.url, body, `${API_TOKEN}x`)).status).toBe(401);
  });

  it('rejects a ticket with a bad MAC', async () => {
    const signed = signTicket(ticket(), TICKET_SECRET);
    const tampered = { ...signed, ticket: { ...signed.ticket, maxLamports: '900000000' } };
    const { status, json } = await post(running.url, { ticket: tampered, transactionBase64: buyTx() });
    expect(status).toBe(403);
    expect(json.reasons).toEqual(['bad ticket signature']);
    const wrongSecret = signTicket(ticket(), 'another-secret-of-sufficient-length-000000');
    expect((await post(running.url, { ticket: wrongSecret, transactionBase64: buyTx() })).status).toBe(403);
  });

  it('rejects an expired ticket and an over-long ticket lifetime', async () => {
    const now = Date.now();
    const expired = await post(running.url, {
      ticket: signTicket(ticket({ issuedAt: now - 120_000, expiresAt: now - 60_000 }), TICKET_SECRET),
      transactionBase64: buyTx(),
    });
    expect(expired.status).toBe(403);
    expect(expired.json.reasons).toEqual(['ticket expired']);
    const tooLong = await post(running.url, {
      ticket: signTicket(ticket({ expiresAt: now + 3_600_000 }), TICKET_SECRET),
      transactionBase64: buyTx(),
    });
    expect(tooLong.status).toBe(403);
    expect(tooLong.json.reasons).toEqual(['ticket lifetime exceeds the signer maximum']);
  });

  it('rejects a replayed ticket after the first success', async () => {
    const body = { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx() };
    expect((await post(running.url, body)).status).toBe(200);
    const replay = await post(running.url, body);
    expect(replay.status).toBe(409);
    // Concurrent duplicates: exactly one may succeed.
    const body2 = { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx(1_000n) };
    const results = await Promise.all([post(running.url, body2), post(running.url, body2), post(running.url, body2)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  });

  it('returns policy denials with reasons and does not consume the ticket', async () => {
    const t = signTicket(ticket(), TICKET_SECRET);
    const bad = toBase64(v0(wallet, [...buyInstructions(wallet), transfer(wallet, ATTACKER, 5n)]));
    const denied = await post(running.url, { ticket: t, transactionBase64: bad });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('policy denied');
    expect((denied.json.reasons as string[]).some((r) => r.includes('unapproved destination'))).toBe(true);
    expect((await post(running.url, { ticket: t, transactionBase64: buyTx() })).status).toBe(200);
  });

  it('enforces the daily cap and keeps it across a restart', async () => {
    const statePath = running.statePath;
    // Each buy counts 100,000,000 wrap + 1,000,000 tip + 200 priority fee = 101,000,200.
    expect(
      (await post(running.url, { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx() })).status,
    ).toBe(200);
    expect(
      (await post(running.url, { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx() })).status,
    ).toBe(200);
    const third = await post(running.url, { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx() });
    expect(third.status).toBe(403);
    expect((third.json.reasons as string[])[0]).toMatch(/daily cap exceeded/);
    if (process.platform !== 'win32') expect(statSync(statePath).mode & 0o777).toBe(0o600);

    await running.signer.close();
    running = await start(statePath);
    const afterRestart = await post(running.url, {
      ticket: signTicket(ticket(), TICKET_SECRET),
      transactionBase64: buyTx(),
    });
    expect(afterRestart.status).toBe(403);
    expect((afterRestart.json.reasons as string[])[0]).toMatch(/202000400 already signed today/);
    // A small transaction that fits under the remaining budget is still allowed.
    const small = await post(running.url, {
      ticket: signTicket(ticket(), TICKET_SECRET),
      transactionBase64: buyTx(1_000_000n),
    });
    expect(small.status).toBe(200);
  });

  it('rejects an oversize body with 413', async () => {
    const big = JSON.stringify({
      ticket: signTicket(ticket(), TICKET_SECRET),
      transactionBase64: 'A'.repeat(MAX_BODY_BYTES),
    });
    const res = await fetch(`${running.url}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it('rejects an oversize chunked body (no content-length) with 413', async () => {
    const port = new URL(running.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/sign',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${API_TOKEN}`,
            'transfer-encoding': 'chunked',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => undefined); // the server closes the socket after answering
      const chunk = 'A'.repeat(8 * 1024);
      for (let i = 0; i < MAX_BODY_BYTES / chunk.length + 2; i++) req.write(chunk);
      req.end();
      setTimeout(() => reject(new Error('no response')), 5_000).unref();
    });
    expect(status).toBe(413);
    expect(running.logs.some((l) => l.event === 'sign_allowed')).toBe(false);
  });

  it('rejects non-JSON content types, malformed JSON and schema violations', async () => {
    const res = await fetch(`${running.url}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${API_TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(415);
    expect((await post(running.url, '{oops')).status).toBe(400);
    expect(
      (await post(running.url, { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: buyTx(), extra: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await post(running.url, { ticket: signTicket(ticket(), TICKET_SECRET), transactionBase64: 'AAAA' })).status,
    ).toBe(400);
  });

  it('rejects requests with a non-loopback Host header (DNS rebinding)', async () => {
    const port = new URL(running.url).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/health', headers: { host: 'attacker.example:80' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('refuses to bind a non-loopback host unless explicitly allowed', () => {
    expect(() =>
      createSignerServer({
        config: config({ host: '0.0.0.0' }),
        keypair,
        state: SignerStateStore.open(join(dir, 'x.json')),
      }),
    ).toThrow(/non-loopback/);
  });
});
