/**
 * Seeded synthetic fixture generator so the replay harness can be demonstrated and tested without recorded data.
 * Every signal is tagged source "synthetic-*" and payload.synthetic = true, and reports built from it are
 * labeled synthetic. The price model (random walk plus occasional pumps that mentions partly anticipate, and
 * rare rugs) is a toy; it exercises the code paths and says nothing about real markets.
 */
import { createRng, type Rng } from '../trader/rng.js';
import type { BacktestInput, PricePoint, SignalEvent, SolPricePoint } from './types.js';

export interface SyntheticOptions {
  seed?: number;
  mints?: number;
  days?: number;
  start?: Date;
  stepSeconds?: number;
  /** Probability per mint per day of a sudden 80% crash. */
  rugRatePerDay?: number;
  pumpsPerDay?: number;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fakeMint(rng: Rng): string {
  let s = '';
  for (let i = 0; i < 44; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return s;
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export function generateSyntheticFixture(o: SyntheticOptions = {}): Required<BacktestInput> & { meta: { synthetic: true; seed: number; mints: string[] } } {
  const seed = o.seed ?? 42;
  const rng = createRng(seed);
  const nMints = o.mints ?? 6;
  const days = o.days ?? 4;
  const start = (o.start ?? new Date('2026-10-28T00:00:00Z')).getTime();
  const step = (o.stepSeconds ?? 30) * 1000;
  const steps = Math.floor((days * 86_400_000) / step);
  const pumpsPerDay = o.pumpsPerDay ?? 4;
  const rugRate = o.rugRatePerDay ?? 0.05;
  const iso = (t: number) => new Date(t).toISOString();

  const prices: PricePoint[] = [];
  const signals: SignalEvent[] = [];
  const solPrices: SolPricePoint[] = [];
  const mints: string[] = [];

  let solUsd = 150;
  for (let i = 0; i < steps; i += Math.max(1, Math.floor(300_000 / step))) {
    solUsd *= 1 + 0.002 * gaussian(rng);
    solPrices.push({ at: iso(start + i * step), solUsd: Math.round(solUsd * 100) / 100 });
  }

  for (let m = 0; m < nMints; m++) {
    const mint = fakeMint(rng);
    mints.push(mint);
    const symbol = `SYN${m}`;
    let price = 0.01 + rng() * 0.5;
    let liq = 30_000 + rng() * 170_000;
    const pumpProb = (pumpsPerDay * step) / 86_400_000;
    const rugProb = (rugRate * step) / 86_400_000;
    let pumpLeft = 0;
    let pumpRate = 0;
    let leadIn = 0;
    let dumpLeft = 0;
    for (let i = 0; i < steps; i++) {
      const t = start + i * step;
      let drift = 0;
      if (leadIn > 0) {
        leadIn -= 1;
        if (leadIn === 0) pumpLeft = 10 + Math.floor(rng() * 20);
      } else if (pumpLeft > 0) {
        drift = pumpRate;
        pumpLeft -= 1;
        if (pumpLeft === 0) dumpLeft = 10 + Math.floor(rng() * 20);
      } else if (dumpLeft > 0) {
        drift = -pumpRate * 0.6;
        dumpLeft -= 1;
      } else if (rng() < pumpProb) {
        leadIn = 2 + Math.floor(rng() * 6);
        pumpRate = 0.004 + rng() * 0.012;
      }
      price *= Math.exp(drift + 0.004 * gaussian(rng));
      if (rng() < rugProb) { price *= 0.2; liq *= 0.3; }
      liq = Math.max(5_000, liq * (1 + 0.003 * gaussian(rng)));
      prices.push({ mint, at: iso(t), priceLamportsPerUnit: price, liquidityUsd: Math.round(liq) });

      // Mentions: elevated during lead-in and pumps (partly predictive), plus background noise.
      const mentions = leadIn > 0 ? 3 + Math.floor(rng() * 3) : pumpLeft > 0 ? 1 + Math.floor(rng() * 3) : rng() < 0.03 ? 1 : 0;
      for (let k = 0; k < mentions; k++) {
        signals.push({ source: 'synthetic-social', mint, kind: 'mention', observedAt: iso(t + Math.floor(rng() * step)), payload: { synthetic: true, symbol } });
      }
      if (i % Math.max(1, Math.floor(3_600_000 / step)) === 0) {
        signals.push({ source: 'synthetic-dexscreener', mint, kind: 'trending', observedAt: iso(t), payload: { synthetic: true, symbol, volume5mUsd: Math.round(liq * 0.05) } });
      }
    }
  }
  signals.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  prices.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { signals, prices, solPrices, meta: { synthetic: true, seed, mints } };
}
