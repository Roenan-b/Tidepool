/**
 * Dashboard -> engine proxy rules, as pure functions so they can be unit-tested without Next.js.
 * Each dashboard route maps to exactly one engine endpoint. Bodies are validated with the core zod
 * schemas and re-serialized from the parsed value, so unknown fields never reach the engine.
 */
import { z } from 'zod';
import {
  ClearHaltRequest,
  KillRequest,
  LIVE_MODE_CONFIRMATION,
  ModeRequest,
  StartRequest,
  WithdrawAddressRequest,
  WithdrawRequest,
} from '@tidepool/core';
import type { Role, Viewer } from './auth/guard.js';

type Method = 'GET' | 'POST';

interface RouteSpec {
  method: Method;
  enginePath: string;
  roles: readonly Role[];
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
}

const BOTH: readonly Role[] = ['owner', 'operator'];
const OWNER: readonly Role[] = ['owner'];
const OPERATOR: readonly Role[] = ['operator'];

const U64_MAX = 18_446_744_073_709_551_615n;
const limit = (max: number) => z.coerce.number().int().min(1).max(max);
const EmptyBody = z.object({}).strict();

export const PROXY_ROUTES = {
  status: { method: 'GET', enginePath: '/status', roles: BOTH, query: z.object({}).strict() },
  positions: {
    method: 'GET',
    enginePath: '/positions',
    roles: BOTH,
    query: z.object({ status: z.enum(['open', 'closed', 'all']).optional(), limit: limit(500).optional() }).strict(),
  },
  candidates: { method: 'GET', enginePath: '/candidates', roles: OPERATOR, query: z.object({ limit: limit(200).optional() }).strict() },
  events: {
    method: 'GET',
    enginePath: '/events',
    roles: OPERATOR,
    query: z
      .object({ limit: limit(200).optional(), beforeSeq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() })
      .strict(),
  },
  metrics: { method: 'GET', enginePath: '/metrics', roles: OPERATOR, query: z.object({}).strict() },
  signals: {
    method: 'GET',
    enginePath: '/signals',
    roles: OPERATOR,
    query: z.object({ limit: limit(500).optional(), source: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional() }).strict(),
  },
  start: { method: 'POST', enginePath: '/control/start', roles: BOTH, body: StartRequest.strict() },
  pause: { method: 'POST', enginePath: '/control/pause', roles: BOTH, body: EmptyBody },
  kill: { method: 'POST', enginePath: '/control/kill', roles: BOTH, body: KillRequest.strict() },
  mode: { method: 'POST', enginePath: '/control/mode', roles: BOTH, body: ModeRequest.strict() },
  clearHalt: { method: 'POST', enginePath: '/control/clear-halt', roles: OPERATOR, body: ClearHaltRequest.strict() },
  withdrawAddress: { method: 'POST', enginePath: '/wallet/withdraw-address', roles: OWNER, body: WithdrawAddressRequest.strict() },
  withdraw: {
    method: 'POST',
    enginePath: '/wallet/withdraw',
    roles: OWNER,
    // Lamport amounts are u64 on chain; anything above u64::MAX cannot be a real amount.
    body: WithdrawRequest.strict().refine(
      (b) => typeof b.lamports === 'string' && /^\d{1,20}$/.test(b.lamports) && BigInt(b.lamports) > 0n && BigInt(b.lamports) <= U64_MAX,
      { message: 'Amount must be a positive number of lamports' },
    ),
  },
} as const satisfies Record<string, RouteSpec>;

export type ProxyRouteKey = keyof typeof PROXY_ROUTES;

export type PreparedProxy =
  | { ok: true; method: Method; enginePath: string; query: URLSearchParams; body: unknown }
  | { ok: false; status: 400 | 403; error: string; message: string };

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return 'Invalid request';
  const where = i.path.length ? `${i.path.join('.')}: ` : '';
  return `${where}${i.message}`.slice(0, 200);
}

/**
 * Validates one proxied request after the viewer has passed the route's role rule.
 * Adds the rules that depend on the request content (live mode is owner only and needs the exact
 * confirmation phrase).
 */
export function prepareProxy(
  key: ProxyRouteKey,
  viewer: Pick<Viewer, 'role' | 'demo'>,
  input: { body?: unknown; search?: URLSearchParams },
): PreparedProxy {
  const spec: RouteSpec = PROXY_ROUTES[key];
  const rawQuery = Object.fromEntries(input.search?.entries() ?? []);
  const q = (spec.query ?? z.object({}).strict()).safeParse(rawQuery);
  if (!q.success) return { ok: false, status: 400, error: 'invalid_query', message: firstIssue(q.error) };
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(q.data as Record<string, unknown>)) {
    if (v !== undefined) query.set(k, String(v));
  }

  if (spec.method === 'GET') return { ok: true, method: 'GET', enginePath: spec.enginePath, query, body: undefined };

  const b = (spec.body ?? EmptyBody).safeParse(input.body ?? {});
  if (!b.success) return { ok: false, status: 400, error: 'invalid_body', message: firstIssue(b.error) };
  let body: unknown = b.data;

  if (key === 'mode') {
    const m = b.data as z.infer<typeof ModeRequest>;
    if (m.mode === 'live') {
      if (viewer.role !== 'owner') {
        return { ok: false, status: 403, error: 'forbidden', message: 'Only the owner can switch to live trading.' };
      }
      if (m.confirm !== LIVE_MODE_CONFIRMATION) {
        return { ok: false, status: 400, error: 'confirmation_mismatch', message: 'Type the confirmation sentence exactly to switch to live.' };
      }
      body = { mode: 'live', confirm: m.confirm };
    } else {
      body = { mode: 'paper' };
    }
  }
  return { ok: true, method: 'POST', enginePath: spec.enginePath, query, body };
}
