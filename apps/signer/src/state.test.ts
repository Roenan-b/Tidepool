import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PRUNE_GRACE_MS, SignerStateStore } from './state.js';

const dir = mkdtempSync(join(tmpdir(), 'signer-state-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-22T10:00:00Z');

describe('signer state', () => {
  it('persists used tickets and daily spend across reopen', () => {
    const path = join(dir, 'a.json');
    const s = SignerStateStore.open(path, T0);
    s.commit({ reservationId: 'r1', ticketExpiresAt: T0 + 60_000, amountLamports: 5n, nowMs: T0 });
    s.commit({ reservationId: 'r2', ticketExpiresAt: T0 + 60_000, amountLamports: 7n, nowMs: T0 });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = SignerStateStore.open(path, T0);
    expect(again.isTicketUsed('r1')).toBe(true);
    expect(again.spentOn(T0)).toBe(12n);
    expect(() => again.commit({ reservationId: 'r1', ticketExpiresAt: T0 + 60_000, amountLamports: 1n, nowMs: T0 })).toThrow(/already used/);
  });

  it('resets the spend total on a new UTC day and prunes expired tickets', () => {
    const path = join(dir, 'b.json');
    const s = SignerStateStore.open(path, T0);
    s.commit({ reservationId: 'old', ticketExpiresAt: T0 + 1_000, amountLamports: 100n, nowMs: T0 });
    const nextDay = T0 + 24 * 3600_000;
    expect(s.spentOn(nextDay)).toBe(0n);
    s.commit({ reservationId: 'new', ticketExpiresAt: nextDay + 1_000, amountLamports: 3n, nowMs: nextDay });
    expect(s.spentOn(nextDay)).toBe(3n);
    expect(s.isTicketUsed('old')).toBe(false);
    expect(s.usedTicketCount()).toBe(1);
  });

  it('keeps used tickets for a grace period after expiry so a clock step back cannot revive them', () => {
    const path = join(dir, 'grace.json');
    const s = SignerStateStore.open(path, T0);
    s.commit({ reservationId: 'r1', ticketExpiresAt: T0 + 1_000, amountLamports: 1n, nowMs: T0 });
    // Shortly after r1 expired, another commit must not prune it yet.
    s.commit({ reservationId: 'r2', ticketExpiresAt: T0 + 120_000, amountLamports: 1n, nowMs: T0 + 60_000 });
    expect(s.isTicketUsed('r1')).toBe(true);
    expect(SignerStateStore.open(path, T0).isTicketUsed('r1')).toBe(true);
    // Once the grace period has passed, it is pruned.
    s.commit({ reservationId: 'r3', ticketExpiresAt: T0 + 2 * PRUNE_GRACE_MS, amountLamports: 1n, nowMs: T0 + 1_001 + PRUNE_GRACE_MS });
    expect(s.isTicketUsed('r1')).toBe(false);
  });

  it('does not reset the daily spend when the clock steps back across midnight', () => {
    const path = join(dir, 'rollback.json');
    const midnight = Date.parse('2026-11-23T00:00:00Z');
    const s = SignerStateStore.open(path, midnight);
    s.commit({ reservationId: 'a', ticketExpiresAt: midnight + 60_000, amountLamports: 40n, nowMs: midnight + 2_000 });
    const before = midnight - 3_000; // clock corrected back into the previous UTC day
    expect(s.spentOn(before)).toBe(40n);
    s.commit({ reservationId: 'b', ticketExpiresAt: midnight + 60_000, amountLamports: 2n, nowMs: before });
    expect(s.spentOn(before)).toBe(42n);
    expect(s.spentOn(midnight + 5_000)).toBe(42n);
    expect(SignerStateStore.open(path, midnight).spentOn(midnight + 5_000)).toBe(42n);
  });

  it('leaves no temporary files behind after commits', () => {
    const sub = mkdtempSync(join(dir, 'tmpcheck-'));
    const s = SignerStateStore.open(join(sub, 'state.json'), T0);
    for (let i = 0; i < 5; i++) s.commit({ reservationId: `t${i}`, ticketExpiresAt: T0 + 60_000, amountLamports: 1n, nowMs: T0 });
    expect(readdirSync(sub)).toEqual(['state.json']);
  });

  it('handles reservation ids that collide with object prototype names', () => {
    const path = join(dir, 'proto.json');
    const s = SignerStateStore.open(path, T0);
    expect(s.isTicketUsed('__proto__')).toBe(false);
    s.commit({ reservationId: '__proto__', ticketExpiresAt: T0 + 1_000, amountLamports: 1n, nowMs: T0 });
    expect(SignerStateStore.open(path, T0).isTicketUsed('__proto__')).toBe(true);
  });

  it('fails closed on a corrupt or group-writable state file', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json', { mode: 0o600 });
    expect(() => SignerStateStore.open(corrupt, T0)).toThrow(/refusing to start/);
    const wrongShape = join(dir, 'shape.json');
    writeFileSync(wrongShape, JSON.stringify({ version: 1, usedTickets: [], daily: { day: 'x', spentLamports: '-1' } }), { mode: 0o600 });
    expect(() => SignerStateStore.open(wrongShape, T0)).toThrow(/invalid format/);
    if (process.platform !== 'win32') {
      const open = join(dir, 'open.json');
      writeFileSync(open, JSON.stringify({ version: 1, usedTickets: [], daily: { day: '2026-11-22', spentLamports: '0' } }));
      chmodSync(open, 0o666);
      expect(() => SignerStateStore.open(open, T0)).toThrow(/writable by group or other/);
    }
  });
});
