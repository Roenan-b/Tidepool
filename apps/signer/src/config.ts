import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { PolicyConfig } from './policy.js';

/** Signer configuration, validated from the environment. Startup fails on any invalid value. */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const lamports = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .regex(/^\d{1,20}$/, `${name} must be an integer number of lamports`)
    .transform((v) => BigInt(v));

const pubkeyList = (name: string, requireOnCurve: boolean) =>
  z
    .string()
    .default('')
    .transform((value, ctx) => {
      const out: string[] = [];
      for (const part of value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        let key: PublicKey;
        try {
          key = new PublicKey(part);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name}: "${part}" is not a valid base58 public key` });
          continue;
        }
        if (key.toBase58() !== part) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${name}: "${part}" is not in canonical base58 form` });
          continue;
        }
        if (requireOnCurve && !PublicKey.isOnCurve(key.toBytes())) {
          // A wallet address is on the ed25519 curve; token accounts and PDAs are not.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${name}: "${part}" is not a wallet address (off curve)`,
          });
          continue;
        }
        out.push(part);
      }
      return [...new Set(out)];
    });

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const EnvSchema = z.object({
  RESERVATION_TICKET_SECRET: z.string().min(32, 'RESERVATION_TICKET_SECRET must be at least 32 characters'),
  SIGNER_HOST: z.string().min(1).default('127.0.0.1'),
  // z.coerce turns an empty string into 0, which would bind a random port; require a real port.
  SIGNER_PORT: z.coerce.number().int().min(1).max(65535).default(7071),
  SIGNER_ALLOW_NON_LOOPBACK: bool,
  SIGNER_API_TOKEN: z.string().min(32, 'SIGNER_API_TOKEN must be at least 32 characters'),
  SIGNER_KEYSTORE_PATH: z.string().min(1).default('./keystore/hot-wallet.keystore.json'),
  SIGNER_STATE_PATH: z.string().min(1).default('./keystore/signer-state.json'),
  SIGNER_MAX_PER_TX_LAMPORTS: lamports('SIGNER_MAX_PER_TX_LAMPORTS'),
  SIGNER_MAX_PER_DAY_LAMPORTS: lamports('SIGNER_MAX_PER_DAY_LAMPORTS'),
  SIGNER_MAX_TIP_LAMPORTS: lamports('SIGNER_MAX_TIP_LAMPORTS'),
  SIGNER_WITHDRAW_ALLOWLIST: pubkeyList('SIGNER_WITHDRAW_ALLOWLIST', true),
  SIGNER_TIP_ACCOUNTS: pubkeyList('SIGNER_TIP_ACCOUNTS', false),
  SIGNER_EXTRA_PROGRAM_IDS: pubkeyList('SIGNER_EXTRA_PROGRAM_IDS', false),
  SIGNER_ALLOW_TOP_LEVEL_TOKEN_TRANSFERS: bool,
  SIGNER_MAX_TICKET_TTL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(300_000),
});

export interface SignerConfig {
  host: string;
  port: number;
  apiToken: string;
  ticketSecret: string;
  keystorePath: string;
  statePath: string;
  maxPerDayLamports: bigint;
  maxTicketTtlMs: number;
  /** Only checked when the server binds a non-loopback host on purpose. */
  allowNonLoopback: boolean;
  policy: PolicyConfig;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/** Parses the signer configuration. The keystore passphrase is handled separately (see main.ts). */
export function loadConfig(env: NodeJS.ProcessEnv): SignerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Issue messages name variables and formats only; they never echo secret values.
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`).join('; ');
    throw new Error(`invalid signer configuration: ${msg}`);
  }
  const e = parsed.data;
  if (!isLoopbackHost(e.SIGNER_HOST) && !e.SIGNER_ALLOW_NON_LOOPBACK) {
    throw new Error(
      `SIGNER_HOST=${e.SIGNER_HOST} is not a loopback address; set SIGNER_ALLOW_NON_LOOPBACK=true only behind a private network`,
    );
  }
  if (e.SIGNER_MAX_PER_TX_LAMPORTS > e.SIGNER_MAX_PER_DAY_LAMPORTS) {
    throw new Error('SIGNER_MAX_PER_TX_LAMPORTS must not exceed SIGNER_MAX_PER_DAY_LAMPORTS');
  }
  if (e.SIGNER_API_TOKEN === e.RESERVATION_TICKET_SECRET) {
    throw new Error('SIGNER_API_TOKEN and RESERVATION_TICKET_SECRET must be different values');
  }
  return {
    host: e.SIGNER_HOST,
    port: e.SIGNER_PORT,
    apiToken: e.SIGNER_API_TOKEN,
    ticketSecret: e.RESERVATION_TICKET_SECRET,
    keystorePath: e.SIGNER_KEYSTORE_PATH,
    statePath: e.SIGNER_STATE_PATH,
    maxPerDayLamports: e.SIGNER_MAX_PER_DAY_LAMPORTS,
    maxTicketTtlMs: e.SIGNER_MAX_TICKET_TTL_MS,
    allowNonLoopback: e.SIGNER_ALLOW_NON_LOOPBACK,
    policy: {
      allowedProgramIds: e.SIGNER_EXTRA_PROGRAM_IDS,
      tipAccounts: e.SIGNER_TIP_ACCOUNTS,
      withdrawAllowlist: e.SIGNER_WITHDRAW_ALLOWLIST,
      maxPerTxLamports: e.SIGNER_MAX_PER_TX_LAMPORTS,
      maxTipLamports: e.SIGNER_MAX_TIP_LAMPORTS,
      allowTopLevelTokenTransfers: e.SIGNER_ALLOW_TOP_LEVEL_TOKEN_TRANSFERS,
    },
  };
}
