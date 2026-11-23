import { z } from 'zod';
import { solToLamports } from '@tidepool/core';

/**
 * Engine configuration loaded from the environment and validated with zod.
 * Fails closed: anything malformed throws at start, and live trading stays off unless
 * LIVE_TRADING_ENABLED is exactly the string "true".
 */

const PLACEHOLDER = /^replace-with/i;

/** Treats empty strings (common in .env files) as unset. */
const optionalString = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);

const optionalUrl = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.url().optional());

function intWithDefault(def: number, min: number, max: number) {
  return z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? def : Number(v)),
    z.number().int().min(min).max(max),
  );
}

function numberWithDefault(def: number, min: number, max: number) {
  return z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? def : Number(v)),
    z.number().min(min).max(max),
  );
}

function lamportsWithDefault(def: bigint) {
  return z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? def.toString() : v),
    z
      .string()
      .regex(/^\d+$/, 'must be a non-negative integer (lamports)')
      .transform((s) => BigInt(s)),
  );
}

const secret = (name: string, min: number) =>
  optionalString.refine((v) => v === undefined || (v.length >= min && !PLACEHOLDER.test(v)), {
    message: `${name} must be at least ${min} characters and not the example placeholder`,
  });

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LIVE_TRADING_ENABLED: z.preprocess((v) => v === 'true', z.boolean()),
  STRETCH_TARGET_USD: numberWithDefault(200, 0, 1_000_000),
  PAPER_STARTING_SOL: numberWithDefault(10, 0, 1_000_000),

  ENGINE_API_HOST: z.preprocess(
    (v) => (v === undefined || v === '' ? '127.0.0.1' : v),
    z.enum(LOOPBACK_HOSTS, { error: 'ENGINE_API_HOST must be a loopback address' }),
  ),
  ENGINE_API_PORT: intWithDefault(7070, 1, 65535),
  ENGINE_API_TOKEN: secret('ENGINE_API_TOKEN', 32).pipe(z.string({ error: 'ENGINE_API_TOKEN is required' })),

  RESERVATION_TICKET_SECRET: secret('RESERVATION_TICKET_SECRET', 32),
  SIGNER_URL: optionalUrl,
  SIGNER_API_TOKEN: secret('SIGNER_API_TOKEN', 32),
  SIGNER_MAX_TIP_LAMPORTS: lamportsWithDefault(2_000_000n),
  SIGNER_MAX_PER_TX_LAMPORTS: lamportsWithDefault(500_000_000n),

  SOLANA_RPC_URL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'https://api.mainnet-beta.solana.com' : v),
    z.url(),
  ),
  HELIUS_API_KEY: optionalString,
  HELIUS_WS_URL: optionalUrl,
  DEXSCREENER_BASE_URL: z.preprocess((v) => (v === undefined || v === '' ? 'https://api.dexscreener.com' : v), z.url()),
  JUPITER_BASE_URL: z.preprocess((v) => (v === undefined || v === '' ? 'https://api.jup.ag' : v), z.url()),
  JUPITER_API_KEY: optionalString,
  LANDING_METHOD: z.preprocess((v) => (v === undefined || v === '' ? 'rpc' : v), z.enum(['rpc', 'sender', 'jito'])),
  SENDER_URL: optionalUrl,
  JITO_BLOCK_ENGINE_URL: optionalUrl,

  LUNARCRUSH_API_KEY: optionalString,
  X_BEARER_TOKEN: optionalString,
  X_CURATED_USER_IDS: optionalString,
  X_MAX_READS_PER_HOUR: intWithDefault(200, 0, 100_000),

  NARRATIVE_API_URL: optionalUrl,
  NARRATIVE_API_KEY: optionalString,
  NARRATIVE_MODEL: optionalString,
  NARRATIVE_MAX_CALLS_PER_HOUR: intWithDefault(120, 0, 100_000),

  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  // Engine tuning knobs with safe defaults (not required in .env).
  RESERVATION_TTL_SECONDS: intWithDefault(60, 5, 600),
  RECONCILE_INTERVAL_SECONDS: intWithDefault(30, 5, 3600),
  RECONCILE_TOLERANCE_LAMPORTS: lamportsWithDefault(0n),
  WITHDRAW_TIMELOCK_HOURS: intWithDefault(24, 1, 24 * 30),
  CONFIG_VERSION: z.preprocess((v) => (v === undefined || v === '' ? 'dev' : v), z.string().max(100)),
  LOG_LEVEL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'info' : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  ),
});

export interface EngineConfig {
  databaseUrl: string;
  liveTradingEnabled: boolean;
  stretchTargetUsd: number;
  paperStartingLamports: bigint;
  api: { host: (typeof LOOPBACK_HOSTS)[number]; port: number; token: string };
  /** Present only when both SIGNER_URL and SIGNER_API_TOKEN are set. */
  signer: { url: string; apiToken: string; maxTipLamports: bigint; maxPerTxLamports: bigint } | null;
  /** HMAC secret for reservation tickets. Always present in live mode. */
  ticketSecret: string | null;
  solana: {
    rpcUrl: string;
    heliusApiKey: string | null;
    heliusWsUrl: string | null;
    landingMethod: 'rpc' | 'sender' | 'jito';
    senderUrl: string | null;
    jitoBlockEngineUrl: string | null;
  };
  dexscreenerBaseUrl: string;
  jupiter: { baseUrl: string; apiKey: string | null };
  social: {
    lunarcrushApiKey: string | null;
    xBearerToken: string | null;
    xCuratedUserIds: string[];
    xMaxReadsPerHour: number;
  };
  narrative: { apiUrl: string | null; apiKey: string | null; model: string | null; maxCallsPerHour: number };
  telegram: { botToken: string; chatId: string } | null;
  risk: {
    reservationTtlSeconds: number;
    reconcileIntervalSeconds: number;
    reconcileToleranceLamports: bigint;
    withdrawTimelockHours: number;
  };
  configVersion: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

function isLoopbackOrHttps(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
  } catch {
    return false;
  }
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid engine configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): EngineConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names and messages only; never echo values, which may be secrets.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const e = parsed.data;
  const issues: string[] = [];

  const signerUrl = e.SIGNER_URL ?? null;
  const signerToken = e.SIGNER_API_TOKEN ?? null;
  if ((signerUrl === null) !== (signerToken === null)) {
    issues.push('SIGNER_URL and SIGNER_API_TOKEN must be set together');
  }
  if (signerUrl !== null && !isLoopbackOrHttps(signerUrl)) {
    // The signer token and reservation tickets travel on this connection.
    issues.push('SIGNER_URL must use https, or http to a loopback address');
  }
  if (e.LIVE_TRADING_ENABLED) {
    if (!e.RESERVATION_TICKET_SECRET)
      issues.push('RESERVATION_TICKET_SECRET (>= 32 chars) is required when LIVE_TRADING_ENABLED=true');
    if (!signerUrl || !signerToken)
      issues.push('SIGNER_URL and SIGNER_API_TOKEN are required when LIVE_TRADING_ENABLED=true');
  }
  if ((e.TELEGRAM_BOT_TOKEN === undefined) !== (e.TELEGRAM_CHAT_ID === undefined)) {
    issues.push('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together');
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return {
    databaseUrl: e.DATABASE_URL,
    liveTradingEnabled: e.LIVE_TRADING_ENABLED,
    stretchTargetUsd: e.STRETCH_TARGET_USD,
    paperStartingLamports: solToLamports(e.PAPER_STARTING_SOL),
    api: { host: e.ENGINE_API_HOST, port: e.ENGINE_API_PORT, token: e.ENGINE_API_TOKEN },
    signer:
      signerUrl && signerToken
        ? {
            url: signerUrl,
            apiToken: signerToken,
            maxTipLamports: e.SIGNER_MAX_TIP_LAMPORTS,
            maxPerTxLamports: e.SIGNER_MAX_PER_TX_LAMPORTS,
          }
        : null,
    ticketSecret: e.RESERVATION_TICKET_SECRET ?? null,
    solana: {
      rpcUrl: e.SOLANA_RPC_URL,
      heliusApiKey: e.HELIUS_API_KEY ?? null,
      heliusWsUrl: e.HELIUS_WS_URL ?? null,
      landingMethod: e.LANDING_METHOD,
      senderUrl: e.SENDER_URL ?? null,
      jitoBlockEngineUrl: e.JITO_BLOCK_ENGINE_URL ?? null,
    },
    dexscreenerBaseUrl: e.DEXSCREENER_BASE_URL,
    jupiter: { baseUrl: e.JUPITER_BASE_URL, apiKey: e.JUPITER_API_KEY ?? null },
    social: {
      lunarcrushApiKey: e.LUNARCRUSH_API_KEY ?? null,
      xBearerToken: e.X_BEARER_TOKEN ?? null,
      xCuratedUserIds: (e.X_CURATED_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d{1,25}$/.test(s)),
      xMaxReadsPerHour: e.X_MAX_READS_PER_HOUR,
    },
    narrative: {
      apiUrl: e.NARRATIVE_API_URL ?? null,
      apiKey: e.NARRATIVE_API_KEY ?? null,
      model: e.NARRATIVE_MODEL ?? null,
      maxCallsPerHour: e.NARRATIVE_MAX_CALLS_PER_HOUR,
    },
    telegram:
      e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID
        ? { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID }
        : null,
    risk: {
      reservationTtlSeconds: e.RESERVATION_TTL_SECONDS,
      reconcileIntervalSeconds: e.RECONCILE_INTERVAL_SECONDS,
      reconcileToleranceLamports: e.RECONCILE_TOLERANCE_LAMPORTS,
      withdrawTimelockHours: e.WITHDRAW_TIMELOCK_HOURS,
    },
    configVersion: e.CONFIG_VERSION,
    logLevel: e.LOG_LEVEL,
  };
}
