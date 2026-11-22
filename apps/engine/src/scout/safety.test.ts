import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PublicKey, type AccountInfo, type ParsedAccountData } from '@solana/web3.js';
import { PRESETS } from '@tidepool/core';
import { evaluateSafety } from './filters.js';
import {
  CreatorBlocklist,
  KNOWN_POOL_AUTHORITIES,
  METAPLEX_METADATA_PROGRAM_ID,
  metadataAddress,
  OnChainSafetyChecker,
  PLATFORM_UPDATE_AUTHORITIES,
  pumpBondingCurveAddress,
  SafetyCheckError,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type MarketInfo,
  type SafetyRpc,
  type SellQuoter,
} from './safety.js';

const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MINT = pk(1);
const PAIR = pk(2);
const SUPPLY = 1_000_000_000n;

type Acc = AccountInfo<Buffer | ParsedAccountData>;

function mintAccount(o: { program?: string; mintAuthority?: string | null; freezeAuthority?: string | null; extensions?: string[] } = {}): Acc {
  const program = o.program ?? TOKEN_PROGRAM_ID;
  return {
    owner: new PublicKey(program),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
    data: {
      program: program === TOKEN_2022_PROGRAM_ID ? 'spl-token-2022' : 'spl-token',
      space: 82,
      parsed: {
        type: 'mint',
        info: {
          mintAuthority: o.mintAuthority ?? null,
          freezeAuthority: o.freezeAuthority ?? null,
          supply: SUPPLY.toString(),
          decimals: 6,
          isInitialized: true,
          ...(o.extensions ? { extensions: o.extensions.map((extension) => ({ extension, state: {} })) } : {}),
        },
      },
    },
  };
}

function tokenAccount(owner: PublicKey): Acc {
  return {
    owner: new PublicKey(TOKEN_PROGRAM_ID),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
    data: { program: 'spl-token', space: 165, parsed: { type: 'account', info: { owner: owner.toBase58(), mint: MINT.toBase58() } } },
  };
}

function metadataAccount(updateAuthority: PublicKey): Acc {
  const data = Buffer.alloc(200);
  data[0] = 4;
  updateAuthority.toBuffer().copy(data, 1);
  MINT.toBuffer().copy(data, 33);
  return { owner: new PublicKey(METAPLEX_METADATA_PROGRAM_ID), lamports: 1, executable: false, rentEpoch: 0, data };
}

interface Holder {
  account: PublicKey;
  owner: PublicKey;
  amount: bigint;
}

function fakeRpc(accounts: Map<string, Acc>, holders: Holder[]) {
  const calls = { multiple: 0, largest: 0 };
  for (const h of holders) accounts.set(h.account.toBase58(), tokenAccount(h.owner));
  const rpc: SafetyRpc = {
    getMultipleParsedAccounts: (async (keys: PublicKey[]) => {
      calls.multiple++;
      return { context: { slot: 1 }, value: keys.map((k) => accounts.get(k.toBase58()) ?? null) };
    }) as SafetyRpc['getMultipleParsedAccounts'],
    getTokenLargestAccounts: (async () => {
      calls.largest++;
      return {
        context: { slot: 1 },
        value: [...holders].sort((a, b) => (b.amount > a.amount ? 1 : -1)).map((h) => ({ address: h.account, amount: h.amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' })),
      };
    }) as SafetyRpc['getTokenLargestAccounts'],
  };
  return { rpc, calls };
}

/** Pool vault (owned by the AMM authority) with 40%, pair-owned vault with 10%, then 12 wallets at 2% each. */
function standardHolders(): Holder[] {
  const list: Holder[] = [
    { account: pk(100), owner: new PublicKey(KNOWN_POOL_AUTHORITIES[0]!), amount: 400_000_000n },
    { account: pk(101), owner: PAIR, amount: 100_000_000n },
  ];
  for (let i = 0; i < 12; i++) list.push({ account: pk(110 + i), owner: pk(150 + i), amount: 20_000_000n });
  return list;
}

const market = (m: Partial<MarketInfo> = {}) => ({
  market: () => ({ liquidityUsd: 60_000, pairAddress: PAIR.toBase58(), pairCreatedAt: new Date('2026-11-22T10:00:00Z'), ...m }),
});
const NOW = new Date('2026-11-22T12:00:00Z');

describe('OnChainSafetyChecker', () => {
  it('reports revoked authorities and top-10 share excluding pool accounts', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const c = new OnChainSafetyChecker({ rpc, market: market(), now: () => NOW });
    const s = await c.check(MINT.toBase58(), 0n);
    expect(s).toMatchObject({
      mint: MINT.toBase58(),
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      token2022Extensions: [],
      liquidityUsd: 60_000,
      creatorFlagged: false,
      ageSeconds: 7_200,
      sellSimulationRatio: null,
    });
    // 10 wallets at 2% each; the two pool vaults are excluded.
    expect(s.top10HolderShare).toBeCloseTo(0.2, 9);
  });

  it('counts the pool vault when the pool owner is unknown (fails toward higher concentration)', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const c = new OnChainSafetyChecker({ rpc, market: market({ pairAddress: null }), now: () => NOW });
    const s = await c.check(MINT.toBase58(), 0n);
    // Raydium authority still excluded; the pair-owned 10% vault is now counted.
    expect(s.top10HolderShare).toBeCloseTo(0.28, 9);
  });

  it('excludes the pump.fun bonding curve and explicitly listed pool accounts', async () => {
    const curve = pumpBondingCurveAddress(MINT);
    const holders: Holder[] = [
      { account: pk(120), owner: curve, amount: 700_000_000n },
      { account: pk(121), owner: pk(60), amount: 50_000_000n },
      { account: pk(122), owner: pk(61), amount: 10_000_000n },
    ];
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, holders);
    const c = new OnChainSafetyChecker({ rpc, market: market({ poolAccounts: [pk(121).toBase58()] }), now: () => NOW });
    const s = await c.check(MINT.toBase58(), 0n);
    expect(s.top10HolderShare).toBeCloseTo(0.01, 9);
  });

  it('reports unrevoked mint and freeze authorities, which the filters reject', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount({ mintAuthority: pk(5).toBase58(), freezeAuthority: pk(6).toBase58() })]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const s = await new OnChainSafetyChecker({ rpc, market: market(), now: () => NOW }).check(MINT.toBase58(), 0n);
    expect(s.mintAuthorityRevoked).toBe(false);
    expect(s.freezeAuthorityRevoked).toBe(false);
    const r = evaluateSafety({ ...s, sellSimulationRatio: 1 }, PRESETS.balanced.filters);
    expect(r.reasons).toEqual(expect.arrayContaining(['mint_authority_not_revoked', 'freeze_authority_not_revoked']));
  });

  it('lists Token-2022 extensions so banned ones are rejected', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount({ program: TOKEN_2022_PROGRAM_ID, extensions: ['transferHook', 'metadataPointer', 'transferHook'] })]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const s = await new OnChainSafetyChecker({ rpc, market: market(), now: () => NOW }).check(MINT.toBase58(), 0n);
    expect(s.token2022Extensions).toEqual(['metadataPointer', 'transferHook']);
    const r = evaluateSafety({ ...s, sellSimulationRatio: 1 }, PRESETS.balanced.filters);
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('banned_token2022_extension:transferHook');
    expect(r.reasons.some((x) => x.includes('metadataPointer'))).toBe(false);
  });

  it('fails closed when the mint is missing, unparsed or owned by another program', async () => {
    const empty = fakeRpc(new Map(), []);
    await expect(new OnChainSafetyChecker({ rpc: empty.rpc, market: market() }).check(MINT.toBase58(), 0n)).rejects.toBeInstanceOf(SafetyCheckError);
    const foreign = mintAccount();
    foreign.owner = pk(77);
    const f = fakeRpc(new Map([[MINT.toBase58(), foreign]]), []);
    await expect(new OnChainSafetyChecker({ rpc: f.rpc, market: market() }).check(MINT.toBase58(), 0n)).rejects.toThrow(/token program/);
    const raw: Acc = { ...mintAccount(), data: Buffer.alloc(82) };
    const r = fakeRpc(new Map([[MINT.toBase58(), raw]]), []);
    await expect(new OnChainSafetyChecker({ rpc: r.rpc, market: market() }).check(MINT.toBase58(), 0n)).rejects.toThrow(/parsed/);
    await expect(new OnChainSafetyChecker({ rpc: r.rpc, market: market() }).check('not-a-mint', 0n)).rejects.toThrow(/invalid mint/);
  });

  it('fails closed when the authority fields are absent or the mint is uninitialized', async () => {
    const noFields = mintAccount();
    const info = (noFields.data as ParsedAccountData).parsed.info as Record<string, unknown>;
    delete info.mintAuthority;
    delete info.freezeAuthority;
    const a = fakeRpc(new Map([[MINT.toBase58(), noFields]]), standardHolders());
    await expect(new OnChainSafetyChecker({ rpc: a.rpc, market: market() }).check(MINT.toBase58(), 0n)).rejects.toThrow(/unexpected shape/);

    const uninit = mintAccount();
    ((uninit.data as ParsedAccountData).parsed.info as Record<string, unknown>).isInitialized = false;
    const b = fakeRpc(new Map([[MINT.toBase58(), uninit]]), standardHolders());
    await expect(new OnChainSafetyChecker({ rpc: b.rpc, market: market() }).check(MINT.toBase58(), 0n)).rejects.toThrow(/not initialized/);
  });

  it('rejects Token-2022 extensions that are not on the vetted list (for example pausable)', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount({ program: TOKEN_2022_PROGRAM_ID, extensions: ['pausableConfig', 'metadataPointer', 'tokenMetadata'] })]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const s = await new OnChainSafetyChecker({ rpc, market: market(), now: () => NOW }).check(MINT.toBase58(), 0n);
    const r = evaluateSafety({ ...s, sellSimulationRatio: 1 }, PRESETS.balanced.filters);
    expect(r.pass).toBe(false);
    expect(r.reasons).toEqual(['unvetted_token2022_extension:pausableConfig']);
  });

  it('sums balances per owner, so splitting one wallet across token accounts does not hide concentration', async () => {
    const whale = pk(70);
    const holders: Holder[] = [
      { account: pk(130), owner: whale, amount: 150_000_000n },
      { account: pk(131), owner: whale, amount: 150_000_000n },
      { account: pk(132), owner: whale, amount: 150_000_000n },
    ];
    for (let i = 0; i < 12; i++) holders.push({ account: pk(140 + i), owner: pk(160 + i), amount: 10_000_000n });
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, holders);
    const s = await new OnChainSafetyChecker({ rpc, market: market(), now: () => NOW }).check(MINT.toBase58(), 0n);
    // Whale 45% plus the next nine wallets at 1% each. Counting accounts would give 37%.
    expect(s.top10HolderShare).toBeCloseTo(0.54, 9);
  });

  it('flags a blocklisted creator from metadata, ignoring the shared launchpad authority', async () => {
    const bad = pk(42);
    const accounts = new Map([
      [MINT.toBase58(), mintAccount()],
      [metadataAddress(MINT).toBase58(), metadataAccount(bad)],
    ]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const flagged = await new OnChainSafetyChecker({ rpc, market: market(), blocklist: new CreatorBlocklist([bad.toBase58()]) }).check(MINT.toBase58(), 0n);
    expect(flagged.creatorFlagged).toBe(true);

    accounts.set(metadataAddress(MINT).toBase58(), metadataAccount(new PublicKey(PLATFORM_UPDATE_AUTHORITIES[0]!)));
    const platform = new OnChainSafetyChecker({ rpc, market: market(), blocklist: new CreatorBlocklist([PLATFORM_UPDATE_AUTHORITIES[0]!]) });
    expect((await platform.check(MINT.toBase58(), 0n)).creatorFlagged).toBe(false);

    const hinted = new OnChainSafetyChecker({ rpc, market: market(), blocklist: new CreatorBlocklist([pk(43).toBase58()]), creatorHints: { creators: () => [pk(43).toBase58()] } });
    expect((await hinted.check(MINT.toBase58(), 0n)).creatorFlagged).toBe(true);
  });

  it('caches static facts within the TTL and shares in-flight lookups', async () => {
    let t = NOW.getTime();
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc, calls } = fakeRpc(accounts, standardHolders());
    const c = new OnChainSafetyChecker({ rpc, market: market(), cacheTtlMs: 10_000, now: () => new Date(t) });
    await Promise.all([c.check(MINT.toBase58(), 0n), c.check(MINT.toBase58(), 0n)]);
    expect(calls.largest).toBe(1);
    expect(c.hasFresh(MINT.toBase58())).toBe(true);
    t += 9_000;
    await c.check(MINT.toBase58(), 0n);
    expect(calls.largest).toBe(1);
    t += 2_000;
    expect(c.hasFresh(MINT.toBase58())).toBe(false);
    await c.check(MINT.toBase58(), 0n);
    expect(calls.largest).toBe(2);
  });

  it('runs the sell simulation only for a positive size and fails soft to null', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    let quotes = 0;
    const quoter: SellQuoter = {
      quoteSell: async ({ sizeLamports }) => {
        quotes++;
        return { expectedLamports: sizeLamports, quotedLamports: (sizeLamports * 85n) / 100n };
      },
    };
    const c = new OnChainSafetyChecker({ rpc, market: market(), sellQuoter: quoter });
    expect((await c.check(MINT.toBase58(), 0n)).sellSimulationRatio).toBeNull();
    expect(quotes).toBe(0);
    const s = await c.check(MINT.toBase58(), 100_000_000n);
    expect(s.sellSimulationRatio).toBeCloseTo(0.85, 9);
    expect(evaluateSafety(s, PRESETS.balanced.filters).reasons).toContain('sell_simulation_below_min');

    const broken = new OnChainSafetyChecker({ rpc, market: market(), sellQuoter: { quoteSell: async () => Promise.reject(new Error('no route')) } });
    const b = await broken.check(MINT.toBase58(), 100_000_000n);
    expect(b.sellSimulationRatio).toBeNull();
    expect(evaluateSafety(b, PRESETS.balanced.filters).reasons).toContain('sell_simulation_missing');
  });

  it('treats unknown market data as zero liquidity and zero age', async () => {
    const accounts = new Map([[MINT.toBase58(), mintAccount()]]);
    const { rpc } = fakeRpc(accounts, standardHolders());
    const s = await new OnChainSafetyChecker({ rpc, market: { market: () => null } }).check(MINT.toBase58(), 0n);
    expect(s.liquidityUsd).toBe(0);
    expect(s.ageSeconds).toBe(0);
  });
});

describe('CreatorBlocklist', () => {
  it('loads a JSON array of addresses and rejects anything else', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'blocklist-'));
    try {
      const good = join(dir, 'good.json');
      await writeFile(good, JSON.stringify([pk(9).toBase58()]));
      const bl = await CreatorBlocklist.fromFile(good);
      expect(bl.has(pk(9).toBase58())).toBe(true);
      const bad = join(dir, 'bad.json');
      await writeFile(bad, JSON.stringify({ wallets: ['x'] }));
      await expect(CreatorBlocklist.fromFile(bad)).rejects.toThrow(/invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ships an empty repository blocklist that parses', async () => {
    const bl = await CreatorBlocklist.fromFile(new URL('../../../../data/creator-blocklist.json', import.meta.url).pathname);
    expect(bl.size).toBe(0);
  });
});
