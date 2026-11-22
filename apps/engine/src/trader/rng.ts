/** Small seeded PRNG (mulberry32) so paper failures and synthetic fixtures are reproducible. Not for cryptography. */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = Math.floor(seed) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
