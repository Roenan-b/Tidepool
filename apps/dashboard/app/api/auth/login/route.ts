import type { NextRequest } from 'next/server';
import { LoginBody } from '../../../../lib/auth/service.js';
import { getAuthService, setPendingCookie, setSessionCookie } from '../../../../lib/auth/server.js';
import { getConfig } from '../../../../lib/config.js';
import { errorJson, json, readJsonBody, rejectCrossOrigin, requestMeta } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

const INVALID = 'Wrong username or password.';

export async function POST(req: NextRequest) {
  if (getConfig().demoMode) return errorJson(403, 'demo_read_only', 'Demo mode does not use sign-in.');
  const bad = rejectCrossOrigin(req);
  if (bad) return bad;
  const body = await readJsonBody(req);
  if (!body.ok) return errorJson(400, 'invalid_body', body.message);
  const parsed = LoginBody.safeParse(body.value);
  if (!parsed.success) return errorJson(401, 'invalid_credentials', INVALID);
  try {
    const r = await getAuthService().passwordStep(parsed.data.username, parsed.data.password, requestMeta(req));
    switch (r.kind) {
      case 'invalid':
        return errorJson(401, 'invalid_credentials', INVALID);
      case 'locked':
        return errorJson(
          429,
          'locked',
          `Too many failed attempts. Try again in ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`,
        );
      case 'totp_required': {
        const res = json({ next: 'totp' });
        setPendingCookie(res, r.pendingTicket);
        return res;
      }
      case 'session': {
        const res = json({ next: 'enroll' });
        setSessionCookie(res, r.token, r.expiresAt);
        return res;
      }
    }
  } catch (err) {
    console.error('[dashboard] login failed:', err instanceof Error ? err.message : 'unknown error');
    return errorJson(503, 'auth_unavailable', 'Sign-in is unavailable right now. Try again shortly.');
  }
}
