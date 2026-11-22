/**
 * Server-side configuration. Values are read from the process environment and validated once.
 * Nothing in this module may be imported by client components: it reads secrets.
 */

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface DashboardConfig {
  nodeEnv: string;
  demoMode: boolean;
  dashboardOrigin: string;
  /** True when cookies must carry the Secure attribute (https origin). */
  secureCookies: boolean;
  sessionTtlHours: number;
  engineUrl: string;
  engineToken: string | null;
  databaseUrl: string | null;
  authEncryptionKey: Buffer | null;
}

const PLACEHOLDER_TOKEN = 'replace-with-64-hex-chars';

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/** Parses AUTH_ENCRYPTION_KEY: base64 that must decode to exactly 32 bytes. */
export function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new ConfigError('AUTH_ENCRYPTION_KEY must be base64');
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== 32) throw new ConfigError('AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

function parseOrigin(raw: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ConfigError(`${name} must use http or https`);
  return url;
}

/**
 * Demo mode serves fixtures and bypasses sign-in, so it must never run on a deployed server.
 * `next build` and `next start` always set NODE_ENV=production, so a production-mode process may
 * only use demo mode for a local preview: loopback origin and no engine token or database configured.
 */
export function demoModeRefusal(env: Record<string, string | undefined>): string | null {
  if (env.DEMO_MODE !== 'true') return null;
  if (env.NODE_ENV !== 'production') return null;
  const origin = env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:3000';
  let loopback: boolean;
  try {
    loopback = isLoopbackHost(new URL(origin).hostname);
  } catch {
    loopback = false;
  }
  if (!loopback) return 'DEMO_MODE is refused in production unless DASHBOARD_ORIGIN is a loopback address';
  if (env.ENGINE_API_TOKEN && env.ENGINE_API_TOKEN !== PLACEHOLDER_TOKEN) {
    return 'DEMO_MODE is refused in production when ENGINE_API_TOKEN is configured';
  }
  if (env.DATABASE_URL) return 'DEMO_MODE is refused in production when DATABASE_URL is configured';
  return null;
}

export function loadConfig(env: Record<string, string | undefined>): DashboardConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const refusal = demoModeRefusal(env);
  if (refusal) throw new ConfigError(refusal);
  const demoMode = env.DEMO_MODE === 'true';

  const originUrl = parseOrigin(env.DASHBOARD_ORIGIN ?? 'http://127.0.0.1:3000', 'DASHBOARD_ORIGIN');
  if (originUrl.pathname !== '/' || originUrl.search || originUrl.hash) {
    throw new ConfigError('DASHBOARD_ORIGIN must be an origin only (scheme, host, optional port)');
  }
  const secureCookies = originUrl.protocol === 'https:';
  if (!secureCookies && !isLoopbackHost(originUrl.hostname)) {
    throw new ConfigError('DASHBOARD_ORIGIN must use https unless it is a loopback address');
  }

  const engineUrlRaw = env.ENGINE_URL ?? 'http://127.0.0.1:7070';
  const engineUrl = parseOrigin(engineUrlRaw, 'ENGINE_URL');
  if (engineUrl.protocol === 'http:' && !isLoopbackHost(engineUrl.hostname)) {
    // The bearer token would cross a network in clear text.
    throw new ConfigError('ENGINE_URL must use https unless it is a loopback address');
  }

  const tokenRaw = env.ENGINE_API_TOKEN?.trim() ?? '';
  const engineToken = tokenRaw === '' || tokenRaw === PLACEHOLDER_TOKEN ? null : tokenRaw;
  if (engineToken !== null && engineToken.length < 32) throw new ConfigError('ENGINE_API_TOKEN is too short');

  const ttlRaw = env.SESSION_TTL_HOURS ?? '12';
  const sessionTtlHours = Number(ttlRaw);
  if (!Number.isInteger(sessionTtlHours) || sessionTtlHours < 1 || sessionTtlHours > 168) {
    throw new ConfigError('SESSION_TTL_HOURS must be an integer between 1 and 168');
  }

  return {
    nodeEnv,
    demoMode,
    dashboardOrigin: originUrl.origin,
    secureCookies,
    sessionTtlHours,
    engineUrl: engineUrl.origin + engineUrl.pathname.replace(/\/$/, ''),
    engineToken,
    databaseUrl: env.DATABASE_URL?.trim() || null,
    authEncryptionKey: parseEncryptionKey(env.AUTH_ENCRYPTION_KEY),
  };
}

let cached: DashboardConfig | null = null;

export function getConfig(): DashboardConfig {
  cached ??= loadConfig(process.env);
  return cached;
}

/** Cheap check usable before full validation (for example in layouts that only need the flag). */
export function isDemoMode(): boolean {
  return getConfig().demoMode;
}
