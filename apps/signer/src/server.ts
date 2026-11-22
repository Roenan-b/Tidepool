import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Keypair } from '@solana/web3.js';
import { verifyTicket, type SignedTicket } from '@tidepool/core/ticket';
import { z } from 'zod';
import { base58Encode } from './base58.js';
import { isLoopbackHost, type SignerConfig } from './config.js';
import { decodeTransaction, evaluatePolicy } from './policy.js';
import type { SignerStateStore } from './state.js';

/**
 * HTTP front of the signer.
 *
 *   GET  /health  -> 200 { ok: true, publicKey }
 *   POST /sign    -> 200 { signedTransactionBase64, signature, spendLamports, tipLamports, priorityFeeLamports, dailySpentLamports }
 *
 * /sign flow: bearer token (constant time) -> body limits and schema -> ticket MAC and expiry ->
 * replay check -> decode -> policy -> per-day cap -> sign -> persist ticket use and spend -> respond.
 * Requests are processed one at a time after parsing so two requests can never race past the
 * replay check or the daily cap.
 */

export const MAX_BODY_BYTES = 64 * 1024;

const decimal = z.string().regex(/^\d{1,20}$/);
const base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

const TicketSchema = z.object({
  v: z.literal(1),
  reservationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  intent: z.enum(['buy', 'sell', 'withdraw']),
  mint: base58Key.nullable(),
  maxLamports: decimal,
  maxTipLamports: decimal,
  destination: base58Key.nullable(),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict();

export const SignRequestSchema = z.object({
  ticket: z.object({ ticket: TicketSchema, mac: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  transactionBase64: z.string().min(4).max(2048).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export type SignRequest = z.infer<typeof SignRequestSchema>;

export interface SignResponse {
  signedTransactionBase64: string;
  signature: string;
  spendLamports: string;
  tipLamports: string;
  priorityFeeLamports: string;
  dailySpentLamports: string;
}

export type LogRecord = Record<string, unknown>;
export type Logger = (record: LogRecord) => void;

export const jsonLineLogger: Logger = (record) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: 'signer', ...record })}\n`);
};

export interface SignerServerOptions {
  config: Pick<SignerConfig, 'host' | 'port' | 'apiToken' | 'ticketSecret' | 'maxPerDayLamports' | 'maxTicketTtlMs' | 'allowNonLoopback' | 'policy'>;
  keypair: Keypair;
  state: SignerStateStore;
  logger?: Logger;
  now?: () => number;
}

export interface SignerServer {
  server: Server;
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(String(body.error ?? 'error'));
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      reject(new HttpError(413, { error: 'request body too large' }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, { error: 'request body too large' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function hostHeaderIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let host = hostHeader.toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  return isLoopbackHost(host);
}

export function createSignerServer(opts: SignerServerOptions): SignerServer {
  const { config, keypair, state } = opts;
  const log = opts.logger ?? jsonLineLogger;
  const now = opts.now ?? Date.now;
  const loopback = isLoopbackHost(config.host);
  if (!loopback && !config.allowNonLoopback) {
    throw new Error(`refusing to bind non-loopback host ${config.host} without SIGNER_ALLOW_NON_LOOPBACK=true`);
  }
  if (config.apiToken.length < 32) throw new Error('SIGNER_API_TOKEN must be at least 32 characters');
  const tokenDigest = digest(config.apiToken);
  const publicKey = keypair.publicKey.toBase58();

  // Serializes the check-sign-commit section.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => T): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization;
    const given = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    // Comparing fixed-length digests keeps the comparison constant time regardless of input length.
    return timingSafeEqual(digest(given), tokenDigest) && given.length > 0;
  };

  const signOnce = (request: SignRequest): SignResponse => {
    const signed = request.ticket as SignedTicket;
    const t = signed.ticket;
    const nowMs = now();
    const base = { reservationId: t.reservationId, intent: t.intent };

    const check = verifyTicket(signed, config.ticketSecret, nowMs);
    if (!check.ok) {
      log({ event: 'sign_denied', ...base, stage: 'ticket', reasons: [check.reason] });
      throw new HttpError(403, { error: 'ticket rejected', reasons: [check.reason] });
    }
    if (t.expiresAt - nowMs > config.maxTicketTtlMs) {
      const reason = 'ticket lifetime exceeds the signer maximum';
      log({ event: 'sign_denied', ...base, stage: 'ticket', reasons: [reason] });
      throw new HttpError(403, { error: 'ticket rejected', reasons: [reason] });
    }
    if (state.isTicketUsed(t.reservationId)) {
      log({ event: 'sign_denied', ...base, stage: 'replay', reasons: ['ticket already used'] });
      throw new HttpError(409, { error: 'ticket already used' });
    }

    let tx;
    try {
      tx = decodeTransaction(request.transactionBase64);
    } catch {
      log({ event: 'sign_denied', ...base, stage: 'decode', reasons: ['transaction could not be decoded'] });
      throw new HttpError(400, { error: 'transaction could not be decoded' });
    }

    const decision = evaluatePolicy({ transaction: tx, wallet: keypair.publicKey, ticket: t, config: config.policy });
    const amounts = {
      spendLamports: decision.spendLamports.toString(),
      tipLamports: decision.tipLamports.toString(),
      priorityFeeLamports: decision.priorityFeeLamports.toString(),
    };
    if (!decision.allow) {
      log({ event: 'sign_denied', ...base, stage: 'policy', reasons: decision.reasons, ...amounts });
      throw new HttpError(403, { error: 'policy denied', reasons: decision.reasons });
    }

    // Everything that can leave the wallet through this transaction counts toward the daily cap.
    const total = decision.spendLamports + decision.tipLamports + decision.priorityFeeLamports;
    const spentToday = state.spentOn(nowMs);
    if (spentToday + total > config.maxPerDayLamports) {
      const reason = `daily cap exceeded: ${spentToday} already signed today + ${total} > ${config.maxPerDayLamports}`;
      log({ event: 'sign_denied', ...base, stage: 'daily_cap', reasons: [reason], ...amounts });
      throw new HttpError(403, { error: 'policy denied', reasons: [reason] });
    }

    tx.sign([keypair]);
    const sig = tx.signatures[0];
    if (!sig || sig.every((b) => b === 0)) throw new Error('signing produced no signature');
    const signature = base58Encode(sig);

    try {
      state.commit({ reservationId: t.reservationId, ticketExpiresAt: t.expiresAt, amountLamports: total, nowMs });
    } catch {
      // The signed bytes are dropped: without a durable record the ticket could be replayed.
      log({ event: 'sign_error', ...base, stage: 'persist' });
      throw new HttpError(500, { error: 'state persistence failed' });
    }

    const dailySpent = state.spentOn(nowMs);
    log({ event: 'sign_allowed', ...base, signature, ...amounts, dailySpentLamports: dailySpent.toString() });
    return {
      signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      signature,
      ...amounts,
      dailySpentLamports: dailySpent.toString(),
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (loopback && !hostHeaderIsLoopback(req.headers.host)) {
      throw new HttpError(421, { error: 'host not allowed' });
    }
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/health') {
      if (req.method !== 'GET') throw new HttpError(405, { error: 'method not allowed' });
      send(res, 200, { ok: true, publicKey });
      return;
    }
    if (path !== '/sign') throw new HttpError(404, { error: 'not found' });
    if (req.method !== 'POST') throw new HttpError(405, { error: 'method not allowed' });
    if (!authorized(req)) {
      log({ event: 'auth_failed', remote: req.socket.remoteAddress ?? null });
      throw new HttpError(401, { error: 'unauthorized' });
    }
    const ctype = req.headers['content-type'] ?? '';
    if (!/^application\/json(\s*;|$)/i.test(ctype)) throw new HttpError(415, { error: 'content-type must be application/json' });

    const body = await readBody(req, MAX_BODY_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, { error: 'body is not valid JSON' });
    }
    const parsed = SignRequestSchema.safeParse(json);
    if (!parsed.success) {
      throw new HttpError(400, { error: 'invalid request', issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const response = await exclusive(() => signOnce(parsed.data));
    send(res, 200, response);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError) {
        if (err.status === 413) {
          // Stop reading the oversized body once the response is flushed.
          res.on('finish', () => req.destroy());
          send(res, err.status, err.body, { connection: 'close' });
          return;
        }
        send(res, err.status, err.body);
        return;
      }
      log({ event: 'internal_error', message: err instanceof Error ? err.message : 'unknown' });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const addr = server.address() as AddressInfo;
          resolve({ host: addr.address, port: addr.port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
