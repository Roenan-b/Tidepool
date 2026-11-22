import { pino, stdSerializers, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured logger with secret redaction. Any field whose name looks like a credential
 * (names ending in token, key or mac, or containing secret, passphrase, password, authorization, cookie,
 * or naming a connection string) is replaced with "[redacted]" at any depth before the line is written.
 * Credentials embedded in URL strings (user:password@, api-key style query parameters, Telegram bot
 * paths) are removed from string values as well.
 */

export const REDACTED = '[redacted]';

const SENSITIVE_SUBSTRINGS = [
  'secret',
  'passphrase',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'seedphrase',
  'mnemonic',
  'connectionstring',
  'databaseurl',
  'database_url',
  'dsn',
];
/** Suffixes that mark credentials. "token" is matched as a suffix only, so trading fields such as tokenAmount stay visible. */
const SENSITIVE_SUFFIXES = ['token', 'key', 'mac'];
/** Names ending in "key" that are identifiers, not credentials. */
const KEY_ALLOWLIST = new Set([
  'idempotencykey',
  'publickey',
  'pubkey',
  'cachekey',
  'primarykey',
  'sortkey',
  'partitionkey',
]);

export function isSensitiveKey(name: string): boolean {
  const k = name.toLowerCase();
  if (KEY_ALLOWLIST.has(k)) return false;
  if (SENSITIVE_SUFFIXES.some((s) => k.endsWith(s))) return true;
  return SENSITIVE_SUBSTRINGS.some((s) => k.includes(s));
}

const MAX_DEPTH = 8;

/** user:password@ in any URL, e.g. a postgres connection string. */
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/** Credential-like query parameters, e.g. an RPC URL with ?api-key=... */
const URL_SECRET_PARAM = /([?&](?:api[-_]?key|key|token|access[-_]?token|secret|password|auth)=)[^&#\s]+/gi;
/** Telegram Bot API URLs carry the bot token in the path. */
const BOT_PATH_TOKEN = /\/bot\d+:[A-Za-z0-9_-]+/g;

/** Removes credentials embedded in URLs inside a string value. */
export function redactString(s: string): string {
  if (!s.includes('://') && !s.includes('/bot') && !s.includes('=')) return s;
  return s
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_SECRET_PARAM, `$1${REDACTED}`)
    .replace(BOT_PATH_TOKEN, `/bot${REDACTED}`);
}

/** Returns a copy of `value` with sensitive fields replaced. Bounded depth; cycles are cut. */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return value; // pino's error serializer handles these
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen));
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactDeep(v, depth + 1, seen);
  }
  return out;
}

export function createLogger(opts: { level?: string; name?: string; destination?: DestinationStream } = {}): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? 'info',
    base: { svc: opts.name ?? 'engine' },
    // Path-based redaction for common transport shapes (fast path), plus deep key matching below.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers["x-api-key"]',
        '*.token',
        '*.secret',
        '*.passphrase',
        '*.password',
      ],
      censor: REDACTED,
    },
    formatters: {
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
      bindings: (b) => redactDeep(b) as Record<string, unknown>,
    },
    serializers: { err: stdSerializers.err },
  };
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

/** Default process logger. Modules should prefer `logger.child({ module: '...' })`. */
export const logger: Logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
