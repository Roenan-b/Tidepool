/**
 * Per-request Content-Security-Policy with a fresh script nonce. Next.js reads the policy from the
 * request headers and applies the nonce to the scripts it renders. Static security headers are set
 * in next.config.mjs. Authentication is enforced in pages and route handlers (Node runtime), not here.
 */
import { NextResponse, type NextRequest } from 'next/server';

export function buildCsp(nonce: string, dev: boolean): string {
  const scriptSrc = [`'self'`, `'nonce-${nonce}'`, `'strict-dynamic'`];
  // React's development build needs eval for fast refresh and stack reconstruction; never in production.
  if (dev) scriptSrc.push(`'unsafe-eval'`);
  return [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    // Inline style attributes carry computed widths (progress bars); no inline scripts are allowed.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `manifest-src 'self'`,
    `worker-src 'self'`,
  ].join('; ');
}

export function proxy(req: NextRequest) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const csp = buildCsp(nonce, process.env.NODE_ENV !== 'production');

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
