/** All on-chain amounts are integers in lamports (1 SOL = 1e9 lamports), carried as bigint. */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol < 0) throw new RangeError(`invalid SOL amount: ${sol}`);
  // Round to the nearest lamport via string math to avoid float drift on large values.
  return BigInt(Math.round(sol * 1e9));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1e9;
}

/** Applies a basis-point fraction with floor rounding: amount * bps / 10_000. */
export function bpsOf(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`bps must be a non-negative integer: ${bps}`);
  return (amount * BigInt(bps)) / 10_000n;
}

export function minBig(a: bigint, b: bigint): bigint { return a < b ? a : b; }
export function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }

/** JSON-safe serialization of bigint fields as decimal strings. */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}
