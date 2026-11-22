import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PublicKey, type AccountInfo, type Connection, type ParsedAccountData } from '@solana/web3.js';
import { z } from 'zod';
import type { TokenSafety } from '@tidepool/core';
import type { SafetyChecker } from '../contracts.js';
import type { ScoutMetrics } from './metrics.js';
import { isMintAddress, LruMap } from './util.js';
import { PUMP_FUN_PROGRAM_ID } from './collectors/heliusParser.js';

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const METAPLEX_METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/** Token account owners that hold pool liquidity rather than circulating supply. */
export const KNOWN_POOL_AUTHORITIES = [
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium AMM v4 authority
  'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', // Raydium CPMM authority
];

/** Owners whose tokens are permanently out of circulation; excluded from the holder share numerator. */
export const BURN_OWNERS = ['1nc1nerator11111111111111111111111111111111'];

/** Launchpad update authorities shared by every token on the platform; they say nothing about the creator. */
export const PLATFORM_UPDATE_AUTHORITIES = ['TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM'];

export class SafetyCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SafetyCheckError';
  }
}

/** Sell simulation hook. The Trader provides a Jupiter-backed implementation. */
export interface SellQuoter {
  /**
   * Quotes selling the tokens a buy of `sizeLamports` would receive. `expectedLamports` is the
   * value implied by the current price for that size; `quotedLamports` is what a sell route returns.
   * Returns null when no route exists.
   */
  quoteSell(args: { mint: string; sizeLamports: bigint }): Promise<{ expectedLamports: bigint; quotedLamports: bigint } | null>;
}

export interface MarketInfo {
  liquidityUsd: number;
  pairAddress: string | null;
  pairCreatedAt: Date | null;
  /** Extra token accounts or owners known to belong to the pool (for example vaults). */
  poolAccounts?: string[];
}

/** Market facts the checker cannot read from the mint itself (liquidity and pair age come from DEX Screener). */
export interface MarketInfoProvider {
  market(mint: string): MarketInfo | null;
}

/** Optional creator addresses observed elsewhere (for example the creator in a pump.fun create event). */
export interface CreatorHintProvider {
  creators(mint: string): string[];
}

export type SafetyRpc = Pick<Connection, 'getMultipleParsedAccounts' | 'getTokenLargestAccounts'>;

const blocklistSchema = z.array(z.string().refine(isMintAddress, 'not a base58 address'));

/** Local list of creator wallets linked to earlier rugs (data/creator-blocklist.json: a JSON array of addresses). */
export class CreatorBlocklist {
  private readonly set: Set<string>;
  constructor(addresses: Iterable<string> = []) {
    this.set = new Set(addresses);
  }
  static async fromFile(path: string): Promise<CreatorBlocklist> {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const parsed = blocklistSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`creator blocklist at ${path} is invalid: expected a JSON array of base58 addresses`);
    return new CreatorBlocklist(parsed.data);
  }
  has(address: string): boolean {
    return this.set.has(address);
  }
  get size(): number {
    return this.set.size;
  }
}

const parsedMintSchema = z.object({
  program: z.string(),
  parsed: z.object({
    type: z.literal('mint'),
    info: z.object({
      // Required: an absent field must not read as a revoked authority (fail closed).
      mintAuthority: z.string().nullable(),
      freezeAuthority: z.string().nullable(),
      supply: z.string().regex(/^\d{1,40}$/),
      decimals: z.number().int().min(0).max(255),
      isInitialized: z.boolean().optional(),
      extensions: z.array(z.object({ extension: z.string().max(64) })).optional(),
    }),
  }),
});

const parsedTokenAccountSchema = z.object({
  parsed: z.object({ type: z.literal('account'), info: z.object({ owner: z.string() }) }),
});

/** Mint-level facts that do not depend on trade size. Cached per mint. */
export interface StaticSafetyFacts {
  mint: string;
  programId: string;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  token2022Extensions: string[];
  top10HolderShare: number;
  creators: string[];
  creatorFlagged: boolean;
  checkedAt: Date;
}

export interface OnChainSafetyCheckerOptions {
  rpc: SafetyRpc;
  market: MarketInfoProvider;
  blocklist?: CreatorBlocklist;
  sellQuoter?: SellQuoter;
  creatorHints?: CreatorHintProvider;
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  rpcTimeoutMs?: number;
  extraPoolOwners?: string[];
  now?: () => Date;
  metrics?: ScoutMetrics;
}

const BONDING_CURVE_DISCRIMINATOR = createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
const BONDING_CURVE_CREATOR_OFFSET = 8 + 8 * 5 + 1;
const METADATA_V1_KEY = 4;
const DEFAULT_PUBKEY = '11111111111111111111111111111111';

export function pumpBondingCurveAddress(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], new PublicKey(PUMP_FUN_PROGRAM_ID))[0];
}

export function metadataAddress(mint: PublicKey): PublicKey {
  const program = new PublicKey(METAPLEX_METADATA_PROGRAM_ID);
  return PublicKey.findProgramAddressSync([Buffer.from('metadata'), program.toBuffer(), mint.toBuffer()], program)[0];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SafetyCheckError(`${what} timed out`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function isParsed(data: Buffer | ParsedAccountData | undefined): data is ParsedAccountData {
  return !!data && !Buffer.isBuffer(data) && typeof data === 'object' && 'parsed' in data;
}

/** Ratio a/b of two non-negative bigints as a float with 1e-9 resolution. */
function ratio(a: bigint, b: bigint): number {
  if (b <= 0n) return 1;
  return Number((a * 1_000_000_000n) / b) / 1e9;
}

/**
 * Reads token safety facts from chain: mint and freeze authorities, owner program and Token-2022
 * extensions, top-10 holder share excluding pool accounts, creator blocklist match, and an
 * optional sell simulation. Any missing or malformed account fails closed by throwing.
 */
export class OnChainSafetyChecker implements SafetyChecker {
  private readonly cache: LruMap<string, StaticSafetyFacts>;
  private readonly inflight = new Map<string, Promise<StaticSafetyFacts>>();
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly blocklist: CreatorBlocklist;

  constructor(private readonly opts: OnChainSafetyCheckerOptions) {
    this.cache = new LruMap(opts.maxCacheEntries ?? 2_000);
    this.ttlMs = opts.cacheTtlMs ?? 20_000;
    this.timeoutMs = opts.rpcTimeoutMs ?? 6_000;
    this.now = opts.now ?? (() => new Date());
    this.blocklist = opts.blocklist ?? new CreatorBlocklist();
  }

  /** Full check. A positive `sizeLamports` runs the sell simulation; 0 skips it (ratio null). */
  async check(mint: string, sizeLamports: bigint): Promise<TokenSafety> {
    const facts = await this.staticFacts(mint);
    const market = this.opts.market.market(mint);
    const now = this.now();
    let sellSimulationRatio: number | null = null;
    if (sizeLamports > 0n && this.opts.sellQuoter) {
      sellSimulationRatio = await this.simulateSell(mint, sizeLamports);
    }
    const createdAt = market?.pairCreatedAt ?? null;
    return {
      mint,
      mintAuthorityRevoked: facts.mintAuthorityRevoked,
      freezeAuthorityRevoked: facts.freezeAuthorityRevoked,
      token2022Extensions: [...facts.token2022Extensions],
      liquidityUsd: market && Number.isFinite(market.liquidityUsd) ? market.liquidityUsd : 0,
      top10HolderShare: facts.top10HolderShare,
      creatorFlagged: facts.creatorFlagged,
      ageSeconds: createdAt ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000)) : 0,
      sellSimulationRatio,
    };
  }

  private async simulateSell(mint: string, sizeLamports: bigint): Promise<number | null> {
    try {
      const q = await withTimeout(this.opts.sellQuoter!.quoteSell({ mint, sizeLamports }), this.timeoutMs, 'sell quote');
      if (!q || q.expectedLamports <= 0n || q.quotedLamports < 0n) return null;
      return ratio(q.quotedLamports, q.expectedLamports);
    } catch {
      this.opts.metrics?.inc('safety.sell_quote_errors');
      return null;
    }
  }

  /** True when mint-level facts for `mint` are cached and within the TTL (no RPC needed). */
  hasFresh(mint: string): boolean {
    const c = this.cache.peek(mint);
    return !!c && this.now().getTime() - c.checkedAt.getTime() < this.ttlMs;
  }

  /** Cached mint-level facts; concurrent callers for one mint share a single RPC round. */
  async staticFacts(mint: string): Promise<StaticSafetyFacts> {
    if (!isMintAddress(mint)) throw new SafetyCheckError('invalid mint address');
    const cached = this.cache.get(mint);
    if (cached && this.now().getTime() - cached.checkedAt.getTime() < this.ttlMs) {
      this.opts.metrics?.inc('safety.cache_hits');
      return cached;
    }
    const running = this.inflight.get(mint);
    if (running) return running;
    const p = this.load(mint)
      .then((f) => {
        this.cache.set(mint, f);
        return f;
      })
      .finally(() => this.inflight.delete(mint));
    this.inflight.set(mint, p);
    return p;
  }

  private async load(mint: string): Promise<StaticSafetyFacts> {
    this.opts.metrics?.inc('safety.rpc_checks');
    const mintKey = new PublicKey(mint);
    const curve = pumpBondingCurveAddress(mintKey);
    const meta = metadataAddress(mintKey);
    const accounts = await withTimeout(this.opts.rpc.getMultipleParsedAccounts([mintKey, meta, curve]), this.timeoutMs, 'mint lookup');
    const [mintAcc, metaAcc, curveAcc] = accounts.value;
    if (!mintAcc) throw new SafetyCheckError('mint account not found');
    const programId = mintAcc.owner.toBase58();
    if (programId !== TOKEN_PROGRAM_ID && programId !== TOKEN_2022_PROGRAM_ID) throw new SafetyCheckError('mint is not owned by a token program');
    if (!isParsed(mintAcc.data)) throw new SafetyCheckError('mint account could not be parsed');
    const parsed = parsedMintSchema.safeParse(mintAcc.data);
    if (!parsed.success) throw new SafetyCheckError('mint account has unexpected shape');
    const info = parsed.data.parsed.info;
    if (info.isInitialized === false) throw new SafetyCheckError('mint is not initialized');
    const supply = BigInt(info.supply);
    if (supply <= 0n) throw new SafetyCheckError('mint supply is zero');
    const token2022Extensions = programId === TOKEN_2022_PROGRAM_ID ? [...new Set((info.extensions ?? []).map((e) => e.extension))].sort() : [];

    const creators = new Set<string>(this.opts.creatorHints?.creators(mint) ?? []);
    const ua = readMetadataUpdateAuthority(metaAcc);
    if (ua && !PLATFORM_UPDATE_AUTHORITIES.includes(ua)) creators.add(ua);
    const curveCreator = readBondingCurveCreator(curveAcc);
    if (curveCreator) creators.add(curveCreator);
    if (info.mintAuthority) creators.add(info.mintAuthority);
    const creatorList = [...creators].filter(isMintAddress);

    const top10HolderShare = await this.top10Share(mintKey, supply, curve.toBase58());
    return {
      mint,
      programId,
      mintAuthorityRevoked: !info.mintAuthority,
      freezeAuthorityRevoked: !info.freezeAuthority,
      token2022Extensions,
      top10HolderShare,
      creators: creatorList,
      creatorFlagged: creatorList.some((c) => this.blocklist.has(c)),
      checkedAt: this.now(),
    };
  }

  private async top10Share(mintKey: PublicKey, supply: bigint, bondingCurve: string): Promise<number> {
    const largest = await withTimeout(this.opts.rpc.getTokenLargestAccounts(mintKey), this.timeoutMs, 'largest accounts');
    const holders = largest.value.map((h) => ({ address: h.address.toBase58(), amount: BigInt(h.amount) }));
    if (holders.length === 0) return 1;
    const market = this.opts.market.market(mintKey.toBase58());
    const excluded = new Set<string>([
      ...KNOWN_POOL_AUTHORITIES,
      ...BURN_OWNERS,
      ...(this.opts.extraPoolOwners ?? []),
      bondingCurve,
      ...(market?.pairAddress ? [market.pairAddress] : []),
      ...(market?.poolAccounts ?? []),
    ]);
    const owners = await withTimeout(
      this.opts.rpc.getMultipleParsedAccounts(holders.map((h) => new PublicKey(h.address))),
      this.timeoutMs,
      'holder owners',
    );
    // Balances are summed per owner: one wallet holding several token accounts is one holder.
    const byOwner = new Map<string, bigint>();
    holders.forEach((h, i) => {
      if (excluded.has(h.address)) return;
      const acc = owners.value[i];
      const ownerParsed = acc && isParsed(acc.data) ? parsedTokenAccountSchema.safeParse(acc.data) : null;
      const owner = ownerParsed?.success ? ownerParsed.data.parsed.info.owner : null;
      if (owner !== null && excluded.has(owner)) return;
      // An account whose owner cannot be read counts as its own holder, which never understates concentration.
      const key = owner ?? `account:${h.address}`;
      byOwner.set(key, (byOwner.get(key) ?? 0n) + h.amount);
    });
    const top = [...byOwner.values()].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 10);
    const sum = top.reduce((acc, x) => acc + x, 0n);
    return Math.min(1, ratio(sum, supply));
  }
}

function readMetadataUpdateAuthority(acc: AccountInfo<Buffer | ParsedAccountData> | null | undefined): string | null {
  if (!acc || acc.owner.toBase58() !== METAPLEX_METADATA_PROGRAM_ID || !Buffer.isBuffer(acc.data)) return null;
  const d = acc.data;
  if (d.length < 65 || d[0] !== METADATA_V1_KEY) return null;
  const ua = new PublicKey(d.subarray(1, 33)).toBase58();
  return ua === DEFAULT_PUBKEY ? null : ua;
}

/** Best effort: newer pump.fun bonding curve accounts store the creator after the reserve fields. */
function readBondingCurveCreator(acc: AccountInfo<Buffer | ParsedAccountData> | null | undefined): string | null {
  if (!acc || acc.owner.toBase58() !== PUMP_FUN_PROGRAM_ID || !Buffer.isBuffer(acc.data)) return null;
  const d = acc.data;
  if (d.length < BONDING_CURVE_CREATOR_OFFSET + 32 || !d.subarray(0, 8).equals(BONDING_CURVE_DISCRIMINATOR)) return null;
  const c = new PublicKey(d.subarray(BONDING_CURVE_CREATOR_OFFSET, BONDING_CURVE_CREATOR_OFFSET + 32)).toBase58();
  return c === DEFAULT_PUBKEY ? null : c;
}
