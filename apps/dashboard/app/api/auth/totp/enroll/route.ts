import type { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { authorize, friendlyAccessError } from '../../../../../lib/auth/guard.js';
import { getAuthService, getViewerFromRequest } from '../../../../../lib/auth/server.js';
import { errorJson, json, rejectCrossOrigin } from '../../../../../lib/http.js';

export const dynamic = 'force-dynamic';

/** Creates a new (not yet enabled) TOTP secret and returns it once, as a QR code and text. */
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
  try {
    const r = await getAuthService().startEnrollment(viewer);
    if (r.kind === 'already_enabled') {
      return errorJson(
        409,
        'already_enabled',
        'Two-factor sign-in is already on. An operator can reset it with the create-user script.',
      );
    }
    const qrDataUrl = await QRCode.toDataURL(r.uri, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
    return json({ qrDataUrl, secret: r.secretBase32, otpauthUri: r.uri });
  } catch (err) {
    console.error('[dashboard] totp enroll failed:', err instanceof Error ? err.message : 'unknown error');
    return errorJson(503, 'auth_unavailable', 'Could not start setup right now. Try again shortly.');
  }
}
