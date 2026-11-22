import type { NextRequest } from 'next/server';
import { handleProxy } from '../../../../lib/proxyHandler.js';

export const dynamic = 'force-dynamic';

export function POST(req: NextRequest) {
  return handleProxy(req, 'withdrawAddress');
}
