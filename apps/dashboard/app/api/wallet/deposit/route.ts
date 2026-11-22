import type { NextRequest } from 'next/server';
import QRCode from 'qrcode';
import { Base58Address, type StatusDto } from '@tidepool/core';
import { authorize, friendlyAccessError } from '../../../../lib/auth/guard.js';
import { getViewerFromRequest } from '../../../../lib/auth/server.js';
import { getConfig } from '../../../../lib/config.js';
import { demoStatus } from '../../../../lib/demo.js';
import { engineRequest } from '../../../../lib/engine.js';
import { errorJson, json } from '../../../../lib/http.js';

export const dynamic = 'force-dynamic';

/** Returns the pool deposit address with a QR code rendered on the server as a PNG data URL. */
export async function GET(req: NextRequest) {
  const viewer = await getViewerFromRequest(req);
  const decision = authorize(viewer, { roles: ['owner', 'operator'] });
  if (!decision.ok || !viewer) {
    const code = decision.ok ? 'unauthenticated' : decision.code;
    return errorJson(decision.ok ? 401 : decision.status, code, friendlyAccessError(code));
  }
  let status: StatusDto;
  if (getConfig().demoMode) {
    status = demoStatus();
  } else {
    const r = await engineRequest<StatusDto>({ method: 'GET', path: '/status', viewer });
    if (!r.ok) return errorJson(r.status, r.error, r.message);
    status = r.data;
  }
  const address = status.wallet?.depositAddress ?? null;
  if (!address || !Base58Address.safeParse(address).success) {
    return errorJson(404, 'no_deposit_address', 'The pool wallet address is not available yet.');
  }
  const qrDataUrl = await QRCode.toDataURL(address, { errorCorrectionLevel: 'M', margin: 2, width: 240 });
  return json({ address, qrDataUrl, mode: status.mode, demo: viewer.demo });
}
