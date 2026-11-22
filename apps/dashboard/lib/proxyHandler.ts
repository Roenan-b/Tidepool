/**
 * Shared route-handler body for every /api/* engine proxy route. Server only.
 * Order: resolve viewer -> demo read-only -> CSRF origin -> role rule -> body/query validation -> engine.
 */
import type { NextRequest, NextResponse } from 'next/server';
import { authorize, friendlyAccessError } from './auth/guard.js';
import { getViewerFromRequest } from './auth/server.js';
import { ConfigError, getConfig } from './config.js';
import { demoCandidates, demoEvents, demoMetrics, demoPositions, demoSignals, demoStatus } from './demo.js';
import { engineRequest } from './engine.js';
import { errorJson, json, readJsonBody, rejectCrossOrigin } from './http.js';
import { PROXY_ROUTES, prepareProxy, type ProxyRouteKey } from './proxy.js';

function demoResponse(key: ProxyRouteKey, query: URLSearchParams): unknown {
  const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
  switch (key) {
    case 'status':
      return demoStatus();
    case 'positions':
      return demoPositions(Date.now(), (query.get('status') as 'open' | 'closed' | 'all' | null) ?? 'all');
    case 'candidates':
      return demoCandidates();
    case 'events':
      return demoEvents(Date.now(), { limit, beforeSeq: query.get('beforeSeq') ? Number(query.get('beforeSeq')) : undefined });
    case 'metrics':
      return demoMetrics();
    case 'signals':
      return demoSignals(Date.now(), limit);
    default:
      return null;
  }
}

export async function handleProxy(req: NextRequest, key: ProxyRouteKey): Promise<NextResponse> {
  try {
    const spec = PROXY_ROUTES[key];
    const mutating = spec.method === 'POST';
    const viewer = await getViewerFromRequest(req);
    if (viewer?.demo && mutating) return errorJson(403, 'demo_read_only', friendlyAccessError('demo_read_only'));
    if (mutating) {
      const bad = rejectCrossOrigin(req);
      if (bad) return bad;
    }
    const decision = authorize(viewer, { roles: spec.roles, mutating });
    if (!decision.ok || !viewer) {
      const code = decision.ok ? 'unauthenticated' : decision.code;
      return errorJson(decision.ok ? 401 : decision.status, code, friendlyAccessError(code));
    }

    let body: unknown;
    if (mutating) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return errorJson(400, 'invalid_body', parsed.message);
      body = parsed.value;
    }
    const prepared = prepareProxy(key, viewer, { body, search: req.nextUrl.searchParams });
    if (!prepared.ok) return errorJson(prepared.status, prepared.error, prepared.message);

    if (getConfig().demoMode) return json(demoResponse(key, prepared.query));

    const result = await engineRequest<unknown>({
      method: prepared.method,
      path: prepared.enginePath,
      query: prepared.query,
      body: prepared.body,
      viewer,
    });
    return result.ok ? json(result.data) : errorJson(result.status, result.error, result.message);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error('[dashboard] configuration error:', err.message);
      return errorJson(503, 'config_error', 'The dashboard is misconfigured. Check the server logs.');
    }
    console.error('[dashboard] proxy failure:', err instanceof Error ? err.message : 'unknown error');
    return errorJson(500, 'internal_error', 'Something went wrong in the dashboard. Check the operations view before retrying.');
  }
}
