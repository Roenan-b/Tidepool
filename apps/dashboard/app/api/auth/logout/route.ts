import type { NextRequest } from 'next/server';
import { clearAuthCookies, getAuthService } from '../../../../lib/auth/server.js';
import { cookieNames } from '../../../../lib/auth/session.js';
import { getConfig } from '../../../../lib/config.js';
import { json, rejectCrossOrigin } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const cfg = getConfig();
  const bad = rejectCrossOrigin(req);
  if (bad) return bad;
  if (!cfg.demoMode) {
    try {
      await getAuthService().logout(req.cookies.get(cookieNames(cfg.secureCookies).session)?.value);
    } catch (err) {
      console.error('[dashboard] logout cleanup failed:', err instanceof Error ? err.message : 'unknown error');
    }
  }
  const res = json({ ok: true });
  clearAuthCookies(res);
  return res;
}
