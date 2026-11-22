/**
 * Server-side client for the engine control API. The bearer token never leaves the server.
 * Every call has a timeout and a bounded response size; failures map to friendly messages.
 */
import type { Viewer } from './auth/guard.js';
import { readBoundedText } from './bounded.js';
import { getConfig, type DashboardConfig } from './config.js';

export const ENGINE_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type EngineResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message: string };

export const ENGINE_UNREACHABLE_MESSAGE =
  'The trading engine is not responding. Nothing was changed. Check that the engine is running and try again in a moment.';

interface EngineCall {
  method: 'GET' | 'POST';
  path: string;
  query?: URLSearchParams;
  body?: unknown;
  viewer: Pick<Viewer, 'role' | 'username'>;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Extracts a short, printable message from an engine error body; never echoes arbitrary payloads. */
export function engineErrorMessage(status: number, body: unknown): { error: string; message: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const clean = (v: unknown, max: number) =>
    typeof v === 'string' ? v.replace(/[^\x20-\x7E]/g, '').slice(0, max) : null;
  const error = clean(b.error, 64) ?? `engine_${status}`;
  if (status >= 500)
    return {
      error,
      message: 'The trading engine hit an internal error. Nothing was confirmed; check the operations view.',
    };
  return { error, message: clean(b.message, 300) ?? `The engine refused the request (${status}).` };
}

export async function engineRequest<T>(
  call: EngineCall,
  deps: { fetch?: FetchLike; config?: DashboardConfig } = {},
): Promise<EngineResult<T>> {
  const cfg = deps.config ?? getConfig();
  if (!cfg.engineToken) {
    return {
      ok: false,
      status: 503,
      error: 'engine_not_configured',
      message: 'The dashboard is not configured to reach the engine (ENGINE_API_TOKEN missing).',
    };
  }
  const qs = call.query && [...call.query.keys()].length > 0 ? `?${call.query.toString()}` : '';
  const url = `${cfg.engineUrl}${call.path}${qs}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.engineToken}`,
    'X-Actor-Role': call.viewer.role,
    'X-Actor-User': call.viewer.username,
    Accept: 'application/json',
  };
  const init: RequestInit = {
    method: call.method,
    headers,
    signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    cache: 'no-store',
    redirect: 'error',
  };
  if (call.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(call.body ?? {});
  }

  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(url, init);
  } catch {
    return { ok: false, status: 502, error: 'engine_unreachable', message: ENGINE_UNREACHABLE_MESSAGE };
  }

  // The size limit is enforced while reading, so an oversized body is never buffered in full.
  const read = await readBoundedText(res.body, MAX_RESPONSE_BYTES);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? {
          ok: false,
          status: 502,
          error: 'engine_response_too_large',
          message: 'The engine sent an unexpectedly large response.',
        }
      : { ok: false, status: 502, error: 'engine_unreachable', message: ENGINE_UNREACHABLE_MESSAGE };
  }
  const text = read.text;
  let parsed: unknown = null;
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 502,
        error: 'engine_bad_response',
        message: 'The engine sent a response the dashboard could not read.',
      };
    }
  }
  if (!res.ok) {
    const { error, message } = engineErrorMessage(res.status, parsed);
    const status = res.status === 401 || res.status >= 500 ? 502 : res.status;
    return {
      ok: false,
      status,
      error,
      message:
        res.status === 401 ? 'The dashboard could not authenticate to the engine. Check ENGINE_API_TOKEN.' : message,
    };
  }
  return { ok: true, data: (parsed ?? {}) as T };
}
