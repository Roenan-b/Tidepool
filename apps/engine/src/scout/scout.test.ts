import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PRESETS, type TokenSafety } from '@tidepool/core';
import { InMemoryCandidateStore } from './candidates.js';
import { MemoryNarrativeStore } from './narrative.js';
import { createScout, Scout, scoutConfigFromEnv, type ScoutSafety } from './scout.js';
import { MemorySignalSink } from './sink.js';
import type { SafetyRpc } from './safety.js';
import type { SignalEvent } from './types.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();
const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map((n) => key(n + 40)) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const NOW = new Date('2026-11-22T12:00:00Z');
const clock = { now: () => NOW };

function profile(mint: string): SignalEvent {
  return {
    source: 'dexscreener',
    mint,
    kind: 'token_profile',
    observedAt: new Date(NOW.getTime() - 30_000),
    payload: { description: 'a dog', links: [] },
  };
}

function snapshot(mint: string, o: Record<string, unknown> = {}): SignalEvent {
  return {
    source: 'dexscreener',
    mint,
    kind: 'pair_snapshot',
    observedAt: new Date(NOW.getTime() - 2_000),
    payload: {
      pairAddress: key(90),
      symbol: 'TKN',
      name: 'Token',
      priceUsd: 0.002,
      liquidityUsd: 80_000,
      volume5mUsd: 15_000,
      volume1hUsd: 90_000,
      priceChange5mPct: 6,
      buys5m: 60,
      sells5m: 40,
      pairCreatedAt: NOW.getTime() - 4 * 3600_000,
      ...o,
    },
  };
}

function goodSafety(mint: string, o: Partial<TokenSafety> = {}): TokenSafety {
  return {
    mint,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    token2022Extensions: [],
    liquidityUsd: 80_000,
    top10HolderShare: 0.2,
    creatorFlagged: false,
    ageSeconds: 14_400,
    sellSimulationRatio: null,
    ...o,
  };
}

function build(safetyImpl: (mint: string) => Promise<TokenSafety>, config: Record<string, unknown> = {}) {
  const store = new InMemoryCandidateStore();
  const persist = new MemorySignalSink();
  const checked: string[] = [];
  const safety: ScoutSafety = {
    check: async (mint) => {
      checked.push(mint);
      return safetyImpl(mint);
    },
    hasFresh: () => false,
  };
  const scout = new Scout({
    persist,
    store,
    safety,
    preset: () => PRESETS.balanced,
    clock,
    config,
    narrativeStore: new MemoryNarrativeStore(),
  });
  return { scout, store, persist, checked };
}

describe('Scout cycle', () => {
  it('publishes a safe surfaced token and records reasons', async () => {
    const { scout, store, persist } = build(async (m) => goodSafety(m));
    scout.sink.emit(profile(A));
    scout.sink.emit(snapshot(A));
    const report = await scout.runCycle();
    expect(report).toMatchObject({ published: 1, vetoed: 0 });
    const top = await scout.topCandidates(5, NOW);
    expect(top).toHaveLength(1);
    expect(top[0]!.mint).toBe(A);
    expect(top[0]!.reasons).toContain('sell_simulation_deferred_to_risk_check');
    expect(top[0]!.expiresAt).toBe(new Date(NOW.getTime() - 2_000 + 90_000).toISOString());
    expect(persist.events).toHaveLength(2);
    expect(store.rows.get(A)!.vetoReason).toBeNull();
  });

  it('never adds a mint to the watchlist from social signals alone', async () => {
    const { scout } = build(async (m) => goodSafety(m));
    scout.sink.emit({ source: 'x', mint: B, kind: 'post', observedAt: NOW, payload: { text: 'buy now' } });
    scout.sink.emit(snapshot(B));
    expect(scout.watchedMints()).not.toContain(B);
    expect((await scout.runCycle()).considered).toBe(0);
  });

  it('vetoes on the market prefilter without spending RPC calls', async () => {
    const { scout, store, checked } = build(async (m) => goodSafety(m));
    scout.sink.emit(profile(C));
    scout.sink.emit(snapshot(C, { liquidityUsd: 1_000 }));
    await scout.runCycle();
    expect(checked).toEqual([]);
    expect(store.rows.get(C)!.vetoReason).toBe('prefilter:liquidity_below_min');
    expect(await scout.topCandidates(5, NOW)).toEqual([]);
  });

  it('vetoes unsafe tokens, records the reason and drops them from the watchlist', async () => {
    const { scout, store } = build(async (m) => goodSafety(m, { mintAuthorityRevoked: false }));
    scout.sink.emit(profile(D));
    scout.sink.emit(snapshot(D));
    await scout.runCycle();
    expect(store.rows.get(D)!.vetoReason).toBe('mint_authority_not_revoked');
    expect(scout.watchedMints()).not.toContain(D);
    scout.sink.emit(profile(D));
    expect(scout.watchedMints()).not.toContain(D);
  });

  it('treats an unvetted Token-2022 extension as a permanent veto', async () => {
    const { scout, store } = build(async (m) => goodSafety(m, { token2022Extensions: ['pausableConfig'] }));
    scout.sink.emit(profile(D));
    scout.sink.emit(snapshot(D));
    await scout.runCycle();
    expect(store.rows.get(D)!.vetoReason).toBe('unvetted_token2022_extension:pausableConfig');
    expect(scout.watchedMints()).not.toContain(D);
  });

  it('vetoes tokens in cooldown for the active mode', async () => {
    const { scout, store } = build(async (m) => goodSafety(m));
    store.cooldowns.set(E, { mode: 'paper', until: new Date(NOW.getTime() + 60_000) });
    scout.sink.emit(profile(E));
    scout.sink.emit(snapshot(E));
    await scout.runCycle();
    expect(store.rows.get(E)!.vetoReason).toBe('cooldown_active');
  });

  it('limits uncached safety lookups per cycle and skips tokens whose check fails', async () => {
    const { scout, store } = build(
      async (m) => {
        if (m === F) throw new Error('rpc down');
        return goodSafety(m);
      },
      { maxSafetyChecksPerCycle: 1 },
    );
    for (const m of [A, F]) {
      scout.sink.emit(profile(m));
      scout.sink.emit(snapshot(m));
    }
    const r1 = await scout.runCycle();
    expect(r1.deferred).toBe(1);
    const r2 = await scout.runCycle();
    expect(r2.deferred).toBe(1);
    // The budget rotates: both mints were tried once across two cycles; the failing one has no row.
    expect(store.rows.has(F)).toBe(false);
    expect(store.rows.has(A)).toBe(true);
    expect(scout.metrics.counter('cycle.safety_errors')).toBe(1);
  });

  it('drops tokens whose market data went stale', async () => {
    const { scout, store } = build(async (m) => goodSafety(m));
    scout.sink.emit(profile(A));
    scout.sink.emit({ ...snapshot(A), observedAt: new Date(NOW.getTime() - 5 * 60_000) });
    await scout.runCycle();
    expect(store.rows.size).toBe(0);
  });
});

describe('createScout', () => {
  it('wires the bundle without network access and keeps optional sources disabled', async () => {
    const config = scoutConfigFromEnv({
      DEXSCREENER_BASE_URL: 'https://api.dexscreener.com',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      X_CURATED_USER_IDS: '1,2',
      CREATOR_BLOCKLIST_PATH: new URL('../../../../data/creator-blocklist.json', import.meta.url).pathname,
    });
    expect(config.heliusRpcUrl).toBeNull();
    expect(config.xBearerToken).toBeNull();
    const fetch = async () => {
      throw new Error('network not allowed in tests');
    };
    const rpc = {} as SafetyRpc;
    const bundle = await createScout({
      config,
      db: { query: async () => ({ rows: [] }) },
      connection: rpc,
      preset: () => PRESETS.balanced,
      fetch,
      store: new InMemoryCandidateStore(),
      persist: new MemorySignalSink(),
      narrativeStore: new MemoryNarrativeStore(),
      clock,
    });
    expect(bundle.narrative.enabled).toBe(false);
    expect(await bundle.candidateSource.topCandidates(5, NOW)).toEqual([]);
    expect(typeof bundle.safetyChecker.check).toBe('function');
    expect(bundle.scout.freshness().stream).toBeNull();
  });

  it('detects a Helius RPC URL for holder counts only on the Helius host', () => {
    expect(scoutConfigFromEnv({ SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=k' }).heliusRpcUrl).toBe(
      'https://mainnet.helius-rpc.com/?api-key=k',
    );
    expect(scoutConfigFromEnv({ SOLANA_RPC_URL: 'https://helius-rpc.com.evil.example/' }).heliusRpcUrl).toBeNull();
    expect(scoutConfigFromEnv({ SOLANA_RPC_URL: 'not a url' }).heliusRpcUrl).toBeNull();
  });
});
