import { describe, expect, it } from 'vitest';
import { Base58Address } from '@tidepool/core';
import { DEMO_DEPOSIT_ADDRESS, demoEvents, demoPositions, demoStatus } from './demo.js';

describe('demo fixtures', () => {
  it('produce a consistent status with integer lamport strings', () => {
    const s = demoStatus(1_700_000_000_000);
    const sum = BigInt(s.pool.cashLamports) + BigInt(s.pool.reservedLamports) + BigInt(s.pool.inPositionsLamports) + BigInt(s.pool.feeReserveLamports);
    expect(BigInt(s.pool.equityLamports)).toBe(sum);
    expect(s.mode).toBe('paper');
    expect(s.liveTradingAllowed).toBe(false);
    expect(Base58Address.safeParse(DEMO_DEPOSIT_ADDRESS).success).toBe(true);
  });

  it('paginate events by beforeSeq', () => {
    const first = demoEvents(0, { limit: 10 });
    expect(first).toHaveLength(10);
    const next = demoEvents(0, { limit: 10, beforeSeq: first[first.length - 1]!.seq });
    expect(next[0]!.seq).toBe(first[first.length - 1]!.seq - 1);
  });

  it('filter positions by status', () => {
    expect(demoPositions(0, 'open').every((p) => p.status !== 'closed')).toBe(true);
    expect(demoPositions(0, 'closed').every((p) => p.status === 'closed')).toBe(true);
  });
});
