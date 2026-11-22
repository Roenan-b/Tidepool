import { describe, expect, it } from 'vitest';
import { bpsOf, lamportsToSol, solToLamports } from './money.js';
import { COST_MODELS, roundTripCostFraction, simulateBuy, simulateSell } from './costModel.js';
import { PRESETS } from './presets.js';
import { signTicket, verifyTicket, type ReservationTicket } from './ticket.js';

const SECRET = 'x'.repeat(64);

function ticket(overrides: Partial<ReservationTicket> = {}): ReservationTicket {
  const now = Date.now();
  return {
    v: 1,
    reservationId: 'r1',
    intent: 'buy',
    mint: 'So11111111111111111111111111111111111111112',
    maxLamports: '100000000',
    maxTipLamports: '1000000',
    destination: null,
    issuedAt: now,
    expiresAt: now + 60_000,
    ...overrides,
  };
}

describe('money', () => {
  it('converts SOL and lamports exactly', () => {
    expect(solToLamports(1.5)).toBe(1_500_000_000n);
    expect(lamportsToSol(250_000_000n)).toBe(0.25);
    expect(() => solToLamports(-1)).toThrow();
  });
  it('applies basis points with floor rounding', () => {
    expect(bpsOf(10_001n, 100)).toBe(100n);
    expect(() => bpsOf(1n, 1.5)).toThrow();
  });
});

describe('cost model', () => {
  it('charges tip and base fee on buys', () => {
    const m = COST_MODELS.graduated;
    const fill = simulateBuy(1_000_000_000n, 1000, m);
    expect(fill.lamportsSpent).toBe(1_000_000_000n + m.tipLamports + 5_000n);
    // 0.3% fee then 1% slippage on price: tokens = 997000000 / 1010
    expect(fill.tokenAmount).toBe(BigInt(Math.floor(997_000_000 / 1010)));
  });
  it('round trip at an unchanged price loses roughly the modelled cost', () => {
    const m = COST_MODELS.bondingCurve;
    const size = 333_333_333n; // about $50 at $150/SOL
    const buy = simulateBuy(size, 500, m);
    const sell = simulateSell(buy.tokenAmount, 500, m);
    const loss = Number(buy.lamportsSpent - sell.lamportsReceived) / Number(size);
    const modelled = roundTripCostFraction(size, m);
    expect(loss).toBeGreaterThan(0.04);
    expect(Math.abs(loss - modelled)).toBeLessThan(0.002);
  });
  it('rejects invalid inputs', () => {
    expect(() => simulateBuy(0n, 1, COST_MODELS.graduated)).toThrow();
    expect(() => simulateBuy(1n, 0, COST_MODELS.graduated)).toThrow();
    expect(() => simulateSell(0n, 1, COST_MODELS.graduated)).toThrow();
  });
});

describe('presets', () => {
  it('keeps every preset within sane bounds', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.limits.maxPositionBps).toBeLessThanOrEqual(1000);
      expect(p.limits.dailyLossLimitBps).toBeLessThanOrEqual(500);
      expect(p.limits.maxDrawdownBps).toBeGreaterThan(p.limits.dailyLossLimitBps);
      expect(p.strategy.takeProfitPct).toBeGreaterThan(p.strategy.stopLossPct);
      expect(p.limits.feeReserveLamports).toBeGreaterThan(0n);
    }
  });
});

describe('reservation tickets', () => {
  it('verifies a valid ticket', () => {
    expect(verifyTicket(signTicket(ticket(), SECRET), SECRET)).toEqual({ ok: true });
  });
  it('rejects a modified ticket', () => {
    const signed = signTicket(ticket(), SECRET);
    signed.ticket.maxLamports = '999999999999';
    expect(verifyTicket(signed, SECRET)).toMatchObject({ ok: false, reason: 'bad ticket signature' });
  });
  it('rejects the wrong secret, expiry, malformed mac and future issue time', () => {
    expect(verifyTicket(signTicket(ticket(), SECRET), 'y'.repeat(64)).ok).toBe(false);
    expect(verifyTicket(signTicket(ticket({ expiresAt: Date.now() - 1 }), SECRET), SECRET)).toMatchObject({
      reason: 'ticket expired',
    });
    expect(verifyTicket({ ticket: ticket(), mac: 'zz' }, SECRET)).toMatchObject({ reason: 'malformed mac' });
    expect(
      verifyTicket(
        signTicket(ticket({ issuedAt: Date.now() + 60_000, expiresAt: Date.now() + 120_000 }), SECRET),
        SECRET,
      ),
    ).toMatchObject({ reason: 'ticket issued in the future' });
  });
  it('requires a destination on withdraw tickets and a strong secret', () => {
    expect(verifyTicket(signTicket(ticket({ intent: 'withdraw', mint: null }), SECRET), SECRET)).toMatchObject({
      ok: false,
    });
    expect(() => signTicket(ticket(), 'short')).toThrow();
  });
});
