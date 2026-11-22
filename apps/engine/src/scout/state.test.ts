import { describe, expect, it } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { Watchlist } from './state.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n)).toBase58();

describe('Watchlist holding tier', () => {
  it('keeps a bare launch until it reaches the minimum age, even under heavy launch volume', () => {
    let t = 0;
    const w = new Watchlist(3, 60_000, () => t);
    const early = key(1);
    w.touch(early, 'helius:new_token', true);
    // Far more launches than the scoring set can hold arrive afterwards.
    for (let i = 2; i < 60; i++) {
      t += 1_000;
      w.touch(key(i), 'helius:new_token', true);
    }
    expect(w.mints()).toEqual([]);
    expect(w.promoteMature(30 * 60_000)).toBe(0);
    t = 30 * 60_000;
    expect(w.promoteMature(30 * 60_000, 1)).toBe(1);
    expect(w.mints()).toEqual([early]);
  });

  it('sends a non-launch surfacing event straight to the scoring set and keeps first-seen order', () => {
    let t = 0;
    const w = new Watchlist(10, 60_000, () => t);
    const m = key(7);
    w.touch(m, 'helius:new_token', true);
    t = 5_000;
    w.touch(m, 'dexscreener:token_profile');
    expect(w.mints()).toEqual([m]);
    expect(w.maturingSize).toBe(0);
    // A later launch event for a mint already being scored does not demote it.
    w.touch(m, 'helius:new_token', true);
    expect(w.mints()).toEqual([m]);
  });

  it('never promotes a blocked mint', () => {
    let t = 0;
    const w = new Watchlist(10, 60 * 60_000, () => t);
    const m = key(8);
    w.touch(m, 'helius:new_token', true);
    w.block(m);
    t = 2 * 60 * 60_000;
    expect(w.promoteMature(0)).toBe(0);
    expect(w.mints()).toEqual([]);
  });
});
