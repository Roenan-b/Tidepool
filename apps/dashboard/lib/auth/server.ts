/**
 * Next.js glue for authentication: resolves the viewer from cookies for pages and route handlers.
 * Server only.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { NextRequest, NextResponse } from 'next/server';
import { ConfigError, getConfig, isLoopbackHost } from '../config.js';
import { getPool } from '../db.js';
import { pageRedirect, type PageName, type Viewer } from './guard.js';
import { AuthService } from './service.js';
import { cookieNames, cookieOptions } from './session.js';
import { PgAuthStore } from './store.js';
import { ReplayGuard } from './totp.js';

export const DEMO_VIEWER: Viewer = {
  userId: '00000000-0000-0000-0000-000000000000',
  username: 'demo',
  role: 'owner',
  totpEnabled: true,
  demo: true,
};

const replay = new ReplayGuard();
let service: AuthService | null = null;

export function getAuthService(): AuthService {
  if (service) return service;
  const cfg = getConfig();
  if (!cfg.authEncryptionKey) throw new ConfigError('AUTH_ENCRYPTION_KEY is not set');
  service = new AuthService({
    store: new PgAuthStore(getPool()),
    key: cfg.authEncryptionKey,
    sessionTtlHours: cfg.sessionTtlHours,
    replay,
  });
  return service;
}

/** Demo mode only answers requests addressed to this machine. */
export function demoHostAllowed(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0] ?? '';
  return isLoopbackHost(host);
}

async function resolve(token: string | undefined, host: string | null): Promise<Viewer | null> {
  const cfg = getConfig();
  if (cfg.demoMode) return demoHostAllowed(host) ? DEMO_VIEWER : null;
  try {
    return await getAuthService().resolveSession(token);
  } catch (err) {
    console.error('[dashboard] session lookup failed:', err instanceof Error ? err.message : 'unknown error');
    return null; // fail closed
  }
}

export async function getViewer(): Promise<Viewer | null> {
  const cfg = getConfig();
  const jar = await cookies();
  const h = await headers();
  return resolve(jar.get(cookieNames(cfg.secureCookies).session)?.value, h.get('host'));
}

export async function getViewerFromRequest(req: NextRequest): Promise<Viewer | null> {
  const cfg = getConfig();
  return resolve(req.cookies.get(cookieNames(cfg.secureCookies).session)?.value, req.headers.get('host'));
}

/** For server components: returns the viewer or redirects to the page they may use. */
export async function requirePage(page: PageName): Promise<Viewer> {
  const viewer = await getViewer();
  const target = pageRedirect(viewer, page);
  if (target) redirect(target);
  return viewer as Viewer;
}

export function setSessionCookie(res: NextResponse, token: string, expiresAt: Date): void {
  const cfg = getConfig();
  const names = cookieNames(cfg.secureCookies);
  res.cookies.set(names.session, token, cookieOptions(cfg.secureCookies, (expiresAt.getTime() - Date.now()) / 1000));
  res.cookies.set(names.pending, '', cookieOptions(cfg.secureCookies, 0));
}

export function setPendingCookie(res: NextResponse, ticket: string): void {
  const cfg = getConfig();
  res.cookies.set(cookieNames(cfg.secureCookies).pending, ticket, cookieOptions(cfg.secureCookies, 300));
}

export function clearAuthCookies(res: NextResponse): void {
  const cfg = getConfig();
  const names = cookieNames(cfg.secureCookies);
  res.cookies.set(names.session, '', cookieOptions(cfg.secureCookies, 0));
  res.cookies.set(names.pending, '', cookieOptions(cfg.secureCookies, 0));
}
