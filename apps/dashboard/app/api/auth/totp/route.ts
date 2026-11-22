import type { NextRequest } from 'next/server';
import { TotpBody } from '../../../../lib/auth/service.js';
import { getAuthService, setSessionCookie } from '../../../../lib/auth/server.js';
import { cookieNames } from '../../../../lib/auth/session.js';
import { getConfig } from '../../../../lib/config.js';
import { errorJson, json, readJsonBody, rejectCrossOrigin, requestMeta } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

/** Second sign-in step: exchanges the pending ticket plus a valid TOTP code for a session. */
export async function POST(req: NextRequest) {
  const cfg = getConfig();
  if (cfg.demoMode) return errorJson(403, 'demo_read_only', 'Demo mode does not use sign-in.');
  const bad = rejectCrossOrigin(req);
  if (bad) return bad;
  const body = await readJsonBody(req);
  if (!body.ok) return errorJson(400, 'invalid_body', body.message);
  const parsed = TotpBody.safeParse(body.value);
  if (!parsed.success) return errorJson(400, 'invalid_code', 'Enter the 6-digit code from your authenticator app.');
  try {
    const ticket = req.cookies.get(cookieNames(cfg.secureCookies).pending)?.value;
    const r = await getAuthService().totpStep(ticket, parsed.data.code, requestMeta(req));
    switch (r.kind) {
      case 'expired':
        return errorJson(401, 'pending_expired', 'The sign-in took too long. Enter your password again.');
      case 'invalid':
        return errorJson(401, 'invalid_code', 'That code did not work. Wait for a new code and try again.');
      case 'locked':
        return errorJson(
          429,
          'locked',
          `Too many failed attempts. Try again in ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`,
        );
      case 'session': {
        const res = json({ next: 'home' });
        setSessionCookie(res, r.token, r.expiresAt);
        return res;
      }
    }
  } catch (err) {
    console.error('[dashboard] totp step failed:', err instanceof Error ? err.message : 'unknown error');
    return errorJson(503, 'auth_unavailable', 'Sign-in is unavailable right now. Try again shortly.');
  }
}
