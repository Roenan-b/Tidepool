import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ClearHaltRequest,
  KillRequest,
  ModeRequest,
  StartRequest,
  WithdrawAddressRequest,
  WithdrawRequest,
  type TradingMode,
} from '@tidepool/core';
import type { EngineControl } from '../contracts.js';
import type { AuditLog } from '../contracts.js';
import type { PgRiskOfficer } from '../risk/pgRiskOfficer.js';
import type { Logger } from '../log.js';
import type { ControlQueries } from './queries.js';
import type { SignedTicket } from '@tidepool/core/ticket';

export type ActorRole = 'owner' | 'operator';

/** The Risk Officer operations the control API needs. PgRiskOfficer satisfies it. */
export type RiskAdmin = Pick<
  PgRiskOfficer,
  'mode' | 'start' | 'pause' | 'killSwitch' | 'clearHalt' | 'setMode' | 'setWithdrawAddress' | 'requestWithdrawal'
>;

export interface ControlApiDeps {
  /** One officer, or a resolver returning the officer for the active mode. */
  riskOfficer: RiskAdmin | ((mode: TradingMode) => RiskAdmin);
  /** Drives the Scout and Trader. Called after the Risk Officer has accepted the change. */
  control: EngineControl;
  queries: ControlQueries;
  config: { api: { token: string; host?: string; port?: number } };
  audit: AuditLog;
  logger?: Logger;
  /** Optional hook so the process can rebuild brokers after a mode switch. */
  onModeChange?: (mode: TradingMode) => Promise<void>;
  rateLimit?: { capacity: number; refillPerSecond: number };
  /**
   * Live mode: receives an authorized withdrawal (with its ticket) for signing and submission.
   * Called without awaiting; the outcome is audited and alerted by the executor.
   */
  submitWithdrawal?: (job: {
    withdrawalId: string;
    lamports: bigint;
    destination: string;
    ticket: SignedTicket;
  }) => void;
}

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Simple in-memory token bucket keyed by route and role. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    // A wall clock stepped backwards must not drive the bucket negative (that would lock out the kill switch).
    const elapsedMs = Number.isFinite(t - b.at) ? Math.max(0, t - b.at) : 0;
    b.tokens = Math.min(this.capacity, b.tokens + (elapsedMs / 1000) * this.refillPerSecond);
    b.at = t;
    if (this.buckets.size > 1000 && !this.buckets.has(key)) this.buckets.clear(); // bounded
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time bearer token comparison (hashing first equalizes lengths). */
export function tokenMatches(header: string | undefined, expected: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const given = header.slice('Bearer '.length);
  return timingSafeEqual(digest(given), digest(expected)) && given.length > 0;
}

const PositionsQuery = z.object({
  status: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
const LimitQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  /** Alias of `before`, the name the dashboard uses. */
  beforeSeq: z.coerce.number().int().positive().optional(),
});
const SignalsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  source: z
    .string()
    .regex(/^[a-z0-9_-]{1,32}$/)
    .optional(),
});
/** Dashboard username forwarded for the audit trail; informational only, never used for authorization. */
const ACTOR_USER = /^[A-Za-z0-9_.-]{1,64}$/;

declare module 'fastify' {
  interface FastifyRequest {
    actorRole?: ActorRole;
    actorUser?: string;
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw new HttpError(
      400,
      `invalid request: ${first ? `${first.path.join('.') || 'body'} ${first.message}` : 'body'}`.slice(0, 200),
    );
  }
  return r.data;
}

/**
 * Builds the engine control API. Every route requires `Authorization: Bearer <ENGINE_API_TOKEN>`
 * and `X-Actor-Role: owner|operator` (set by the dashboard server after it authenticates the user).
 * The returned instance is not listening; use `listenControlApi` to bind it to loopback.
 */
export function buildControlApi(deps: ControlApiDeps): FastifyInstance {
  const token = deps.config.api.token;
  if (typeof token !== 'string' || token.length < 32)
    throw new Error('control API token must be at least 32 characters');
  const limiter = new TokenBucketLimiter(deps.rateLimit?.capacity ?? 10, deps.rateLimit?.refillPerSecond ?? 1);
  const log = deps.logger;
  const officerFor = async (): Promise<RiskAdmin> => {
    if (typeof deps.riskOfficer === 'function') return deps.riskOfficer(await deps.queries.activeMode());
    return deps.riskOfficer;
  };

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: false, return503OnClosing: true });

  app.addHook('onRequest', async (req, reply) => {
    if (!tokenMatches(req.headers.authorization, token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const role = req.headers['x-actor-role'];
    if (role !== 'owner' && role !== 'operator') {
      return reply.code(403).send({ error: 'missing or invalid X-Actor-Role' });
    }
    req.actorRole = role;
    const user = req.headers['x-actor-user'];
    if (typeof user === 'string' && ACTOR_USER.test(user)) req.actorUser = user;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) {
      void reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    const e = err as { statusCode?: number; message?: string; code?: string };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500 ? e.statusCode : 500;
    if (status >= 500) log?.error({ err: { message: e.message, code: e.code }, url: req.url }, 'control api error');
    const message =
      err instanceof HttpError
        ? err.message
        : status === 413
          ? 'request body too large'
          : status === 400
            ? 'invalid request'
            : status >= 500
              ? 'internal error'
              : 'request failed';
    void reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: 'not found' });
  });

  async function recordMutation(
    req: FastifyRequest,
    route: string,
    status: number,
    outcome: Record<string, unknown>,
  ): Promise<void> {
    try {
      await deps.audit.append({
        actor: req.actorRole ?? 'operator',
        type: 'control_api_request',
        ref: null,
        payload: { route, status, actorUser: req.actorUser ?? null, ...outcome },
      });
    } catch (err) {
      log?.error({ err: { message: (err as Error).message }, route }, 'failed to audit control api request');
    }
  }

  /** Wraps a mutating route: role check, rate limit, body validation, audit of every outcome. */
  function mutation<T extends z.ZodType>(
    route: string,
    schema: T | null,
    allowed: (role: ActorRole, body: z.infer<T>) => boolean,
    handler: (body: z.infer<T>, role: ActorRole) => Promise<{ status: number; body: Record<string, unknown> }>,
  ) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const role = req.actorRole!;
      if (!limiter.take(`${route}:${role}`)) {
        await recordMutation(req, route, 429, { outcome: 'rate_limited' });
        return reply.code(429).send({ error: 'too many requests' });
      }
      let body: z.infer<T>;
      try {
        // Routes without a schema take no body; their handlers ignore it.
        body = (schema ? parse(schema, req.body) : undefined) as z.infer<T>;
      } catch (err) {
        await recordMutation(req, route, 400, { outcome: 'invalid_body' });
        throw err;
      }
      if (!allowed(role, body)) {
        await recordMutation(req, route, 403, { outcome: 'forbidden' });
        return reply.code(403).send({ error: 'forbidden for this role' });
      }
      try {
        const res = await handler(body, role);
        await recordMutation(req, route, res.status, {
          outcome: res.status < 300 ? 'ok' : 'refused',
          result: res.body,
        });
        return await reply.code(res.status).send(res.body);
      } catch (err) {
        const status = err instanceof HttpError ? err.statusCode : 500;
        await recordMutation(req, route, status, {
          outcome: 'error',
          error: err instanceof HttpError ? err.message : 'internal error',
        });
        throw err;
      }
    };
  }

  const anyRole = () => true;
  const refused = (reason: string) => ({ status: 409, body: { error: reason } });
  const bigintSafe = (v: Record<string, unknown>) =>
    JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as Record<
      string,
      unknown
    >;

  // ---- Reads ----
  app.get('/status', async () => deps.queries.status());
  app.get('/positions', async (req) => {
    const q = parse(PositionsQuery, req.query);
    return deps.queries.positions({ status: q.status, limit: q.limit });
  });
  app.get('/candidates', async (req) => deps.queries.candidates(parse(LimitQuery, req.query).limit));
  app.get('/events', async (req) => {
    const q = parse(EventsQuery, req.query);
    return deps.queries.events({ limit: q.limit, before: q.before ?? q.beforeSeq ?? null });
  });
  app.get('/metrics', async () => deps.queries.metrics());
  app.get('/signals', async (req) => {
    const q = parse(SignalsQuery, req.query);
    return deps.queries.signals(q.limit, q.source ?? null);
  });

  // ---- Controls ----
  app.post(
    '/control/start',
    mutation('/control/start', StartRequest, anyRole, async (body, role) => {
      const officer = await officerFor();
      const r = await officer.start(body.preset, role);
      if (!r.ok) return refused(r.reason);
      await deps.control.start(body.preset);
      return { status: 200, body: { ok: true, state: r.state, haltReason: r.haltReason } };
    }),
  );

  app.post(
    '/control/pause',
    mutation('/control/pause', null, anyRole, async (_b, role) => {
      const officer = await officerFor();
      const r = await officer.pause(role);
      if (!r.ok) return refused(r.reason);
      await deps.control.pause();
      return { status: 200, body: { ok: true, state: r.state, haltReason: r.haltReason } };
    }),
  );

  app.post(
    '/control/kill',
    mutation('/control/kill', KillRequest, anyRole, async (_b, role) => {
      const officer = await officerFor();
      const r = await officer.killSwitch(role);
      try {
        await deps.control.killSwitch();
      } catch {
        // The ledger is halted and positions are marked closing; the Trader failed to acknowledge.
        throw new HttpError(
          502,
          'kill switch recorded but the trader did not acknowledge; positions are marked for sale',
        );
      }
      return {
        status: 200,
        body: { ok: true, positionsClosing: r.positionsClosing, reservationsReleased: r.reservationsReleased },
      };
    }),
  );

  app.post(
    '/control/mode',
    mutation(
      '/control/mode',
      ModeRequest,
      (role, body) => body.mode === 'paper' || role === 'owner',
      async (body, role) => {
        const officer = await officerFor();
        const r = await officer.setMode(body.mode, body.confirm, role);
        if (!r.ok) return refused(r.reason);
        if (deps.onModeChange) await deps.onModeChange(r.mode);
        return { status: 200, body: { ok: true, mode: r.mode } };
      },
    ),
  );

  app.post(
    '/control/clear-halt',
    mutation(
      '/control/clear-halt',
      ClearHaltRequest,
      (role) => role === 'operator',
      async (body, role) => {
        const officer = await officerFor();
        const r = await officer.clearHalt(body.reason, role);
        if (!r.ok) return refused(r.reason);
        return { status: 200, body: { ok: true, state: r.state, haltReason: r.haltReason } };
      },
    ),
  );

  // ---- Wallet (owner only) ----
  app.post(
    '/wallet/withdraw-address',
    mutation(
      '/wallet/withdraw-address',
      WithdrawAddressRequest,
      (role) => role === 'owner',
      async (body, role) => {
        const officer = await officerFor();
        try {
          const r = await officer.setWithdrawAddress(body.address, role);
          return {
            status: 200,
            body: { ok: true, status: r.status, address: r.address, effectiveAt: r.effectiveAt.toISOString() },
          };
        } catch (err) {
          if ((err as Error).name === 'RiskError') throw new HttpError(400, 'invalid address');
          throw err;
        }
      },
    ),
  );

  app.post(
    '/wallet/withdraw',
    mutation(
      '/wallet/withdraw',
      WithdrawRequest,
      (role) => role === 'owner',
      async (body, role) => {
        const lamports = BigInt(body.lamports);
        if (lamports <= 0n) throw new HttpError(400, 'invalid request: lamports must be positive');
        const officer = await officerFor();
        const r = await officer.requestWithdrawal(lamports, role);
        if (!r.ok) return refused(r.reason);
        // The ticket goes to the signer path, never back to the dashboard.
        let submitted = false;
        if (r.ticket !== null && deps.submitWithdrawal) {
          deps.submitWithdrawal({
            withdrawalId: r.withdrawalId,
            lamports: r.lamports,
            destination: r.destination,
            ticket: r.ticket,
          });
          submitted = true;
        }
        return {
          status: 200,
          body: bigintSafe({
            ok: true,
            withdrawalId: r.withdrawalId,
            lamports: r.lamports,
            destination: r.destination,
            requiresSigner: r.ticket !== null,
            submitted,
          }),
        };
      },
    ),
  );

  return app;
}

/** Binds the API to a loopback address only. */
export async function listenControlApi(
  app: FastifyInstance,
  cfg: { api: { host: string; port: number } },
): Promise<string> {
  const host = cfg.api.host === 'localhost' ? '127.0.0.1' : cfg.api.host;
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('control API must bind to a loopback address');
  return app.listen({ host, port: cfg.api.port });
}
