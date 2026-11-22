import type { NextRequest } from 'next/server';
import { authorize, friendlyAccessError } from '../../../../../lib/auth/guard.js';
import { TotpBody } from '../../../../../lib/auth/service.js';
import { getAuthService, getViewerFromRequest, setSessionCookie } from '../../../../../lib/auth/server.js';
import { errorJson, json, readJsonBody, rejectCrossOrigin, requestMeta } from '../../../../../lib/http.js';

export const dynamic = 'force-dynamic';

/** Turns TOTP on only after the user proves the authenticator produces valid codes. */
export async function POST(req: NextRequest) {
  const viewer = await getViewerFromRequest(req);
  if (viewer?.demo) return errorJson(403, 'demo_read_only', friendlyAccessError('demo_read_only'));
  const bad = rejectCrossOrigin(req);
  if (bad) return bad;
  const decision = authorize(viewer, { roles: ['owner', 'operator'], allowWithoutTotp: true, mutating: true });
  if (!decision.ok || !viewer) {
    const code = decision.ok ? 'unauthenticated' : decision.code;
    return errorJson(decision.ok ? 401 : decision.status, code, friendlyAccessError(code));
  }
  const body = await readJsonBody(req);
  if (!body.ok) return errorJson(400, 'invalid_body', body.message);
  const parsed = TotpBody.safeParse(body.value);
  if (!parsed.success) return errorJson(400, 'invalid_code', 'Enter the 6-digit code from your authenticator app.');
  try {
    const r = await getAuthService().confirmEnrollment(viewer, parsed.data.code, requestMeta(req));
    switch (r.kind) {
      case 'ok': {
        // Every earlier session of this user was ended; this client continues on a fresh one.
        const res = json({ ok: true });
        setSessionCookie(res, r.token, r.expiresAt);
        return res;
      }
      case 'already_enabled':
        return errorJson(409, 'already_enabled', 'Two-factor sign-in is already on.');
      case 'locked':
        return errorJson(429, 'locked', `Too many failed attempts. Try again in ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`);
      case 'invalid':
        return errorJson(400, 'invalid_code', 'That code did not match. Check the time on your phone and try the next code.');
    }
  } catch (err) {
    console.error('[dashboard] totp enable failed:', err instanceof Error ? err.message : 'unknown error');
    return errorJson(503, 'auth_unavailable', 'Could not finish setup right now. Try again shortly.');
  }
}
