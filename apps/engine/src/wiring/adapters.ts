import type { SellQuoter as ScoutSellQuoter } from '../scout/index.js';
import type { SellQuoter as TraderSellQuoter, JupiterClient } from '../trader/index.js';
import { SOL_MINT } from '../trader/index.js';

/** Adapts the Jupiter round-trip ratio quoter to the shape the Scout's safety checker expects. */
export function toScoutSellQuoter(q: TraderSellQuoter): ScoutSellQuoter {
  return {
    async quoteSell({ mint, sizeLamports }) {
      const ratio = await q.quoteSellRatio(mint, sizeLamports);
      if (ratio === null || !Number.isFinite(ratio) || ratio < 0) return null;
      // Ratio is quoted SOL back per SOL in; scale with integer math at 1e6 precision.
      const quoted = (sizeLamports * BigInt(Math.floor(ratio * 1_000_000))) / 1_000_000n;
      return { expectedLamports: sizeLamports, quotedLamports: quoted };
    },
  };
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Polls the SOL/USD price from a 1 SOL to USDC quote. Returns null when stale or never fetched. */
export class SolPriceFeed {
  private price: number | null = null;
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly client: Pick<JupiterClient, 'quote'>, private readonly opts: { intervalMs?: number; maxAgeMs?: number; onError?: (e: unknown) => void } = {}) {}

  get(): number | null {
    const maxAge = this.opts.maxAgeMs ?? 5 * 60_000;
    return this.price !== null && Date.now() - this.fetchedAt <= maxAge ? this.price : null;
  }

  async refresh(): Promise<void> {
    try {
      const q = await this.client.quote({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: 1_000_000_000n, slippageBps: 50 });
      const usd = Number(BigInt(q.outAmount)) / 1e6;
      if (Number.isFinite(usd) && usd > 1 && usd < 100_000) {
        this.price = usd;
        this.fetchedAt = Date.now();
      }
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.intervalMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Tracks success and failure of RPC calls for the ops view and the circuit breaker. */
export class RpcHealthTracker {
  private events: Array<{ at: number; ok: boolean }> = [];
  private lastOk: number | null = null;

  record(ok: boolean): void {
    const now = Date.now();
    this.events.push({ at: now, ok });
    if (ok) this.lastOk = now;
    const cutoff = now - 10 * 60_000;
    while (this.events.length > 0 && (this.events[0]!.at < cutoff || this.events.length > 1000)) this.events.shift();
  }

  snapshot(): { healthy: boolean; lastOkAt: string | null; errorRate: number } {
    const n = this.events.length;
    const errors = this.events.filter((e) => !e.ok).length;
    const errorRate = n === 0 ? 0 : errors / n;
    const recentOk = this.lastOk !== null && Date.now() - this.lastOk < 2 * 60_000;
    return { healthy: recentOk && errorRate < 0.5, lastOkAt: this.lastOk ? new Date(this.lastOk).toISOString() : null, errorRate };
  }
}

/** Largest live position the signer's per-transaction cap allows after tip and a 0.01 SOL margin. */
export function liveSizeCap(maxPerTxLamports: bigint, maxTipLamports: bigint): bigint {
  const cap = maxPerTxLamports - maxTipLamports - 10_000_000n;
  return cap > 0n ? cap : 0n;
}
