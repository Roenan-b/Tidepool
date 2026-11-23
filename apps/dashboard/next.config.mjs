/**
 * Next.js configuration for the Tidepool dashboard.
 * The Content-Security-Policy is set per request in proxy.ts (it carries a nonce);
 * the static security headers below apply to every response.
 */

const staticSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
];

const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? '';
if (dashboardOrigin.startsWith('https://')) {
  staticSecurityHeaders.push({ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' });
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
  async headers() {
    return [{ source: '/:path*', headers: staticSecurityHeaders }];
  },
  // Builds use webpack (`--webpack` in package.json) because Turbopack has no equivalent of
  // extensionAlias, and source files import siblings with a `.js` suffix (the ESM convention
  // used across the repo).
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
