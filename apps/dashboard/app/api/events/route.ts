import type { NextRequest } from 'next/server';
import { handleProxy } from '../../../lib/proxyHandler.js';

export const dynamic = 'force-dynamic';

export function GET(req: NextRequest) {
  return handleProxy(req, 'events');
}
