import { describe, expect, it } from 'vitest';
import { displayText, formatLamportsUsd, formatSol, formatUsdCents, formatUsdWhole, lamportsToUsdCents, parseSolInput, shortAddress } from './format.js';

describe('formatSol', () => {
  it('formats lamports with grouping and rounding', () => {
    expect(formatSol('1000000000')).toBe('1.0000 SOL');
    expect(formatSol(1_234_567_890_123n)).toBe('1,234.5679 SOL');
    expect(formatSol('-214000000')).toBe('-0.2140 SOL');
    expect(formatSol('1', 9)).toBe('0.000000001 SOL');
    expect(formatSol('50000', 4)).toBe('0.0001 SOL');
    expect(formatSol('49999', 4)).toBe('0.0000 SOL');
    expect(formatSol('71000000', 4, { signed: true, unit: false })).toBe('+0.0710');
    expect(formatSol('0', 2, { signed: true })).toBe('0.00 SOL');
  });
  it('handles amounts beyond 2^53 exactly', () => {
    expect(formatSol('123456789012345678901', 9)).toBe('123,456,789,012.345678901 SOL');
  });
  it('rejects non-integer input', () => {
    expect(() => formatSol('1.5')).toThrow();
  });
});

describe('USD conversion', () => {
  it('converts lamports to integer cents', () => {
    expect(lamportsToUsdCents('1000000000', 187.42)).toBe(18742n);
    expect(lamportsToUsdCents('-214000000', 187.4)).toBe(-4010n);
    expect(lamportsToUsdCents('800000000', 187.5)).toBe(15000n);
    expect(lamportsToUsdCents('1', null)).toBeNull();
    expect(lamportsToUsdCents('1', Number.NaN)).toBeNull();
  });
  it('formats cents and whole dollars', () => {
    expect(formatUsdCents(123456n)).toBe('$1,234.56');
    expect(formatUsdCents(-4000n)).toBe('-$40.00');
    expect(formatUsdCents(5n, { signed: true })).toBe('+$0.05');
    expect(formatUsdWhole(150)).toBe('$150');
    expect(formatUsdWhole(-40.4)).toBe('-$40');
    expect(formatLamportsUsd('1000000000', 200, { signed: true })).toBe('+$200.00');
    expect(formatLamportsUsd('1000000000', null)).toBeNull();
  });
});

describe('parseSolInput', () => {
  it('parses decimals without floating point error', () => {
    expect(parseSolInput('1.5')).toBe(1_500_000_000n);
    expect(parseSolInput('0.1')).toBe(100_000_000n);
    expect(parseSolInput('0.000000001')).toBe(1n);
    expect(parseSolInput('1,000')).toBe(1_000_000_000_000n);
    expect(parseSolInput('.5')).toBe(500_000_000n);
  });
  it('rejects bad input', () => {
    for (const bad of ['', '.', '0', '-1', '1e3', 'abc', '0.0000000001', '1.2.3', ' ']) expect(parseSolInput(bad)).toBeNull();
  });
});

describe('shortAddress', () => {
  it('abbreviates long addresses', () => {
    expect(shortAddress('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe('9xQe...VFin');
    expect(shortAddress('short')).toBe('short');
  });
});

describe('displayText', () => {
  it('strips bidi overrides, zero-width and control characters from untrusted names', () => {
    // "\u202E" would render the rest right-to-left, so "KNOB" could display as "BONK".
    expect(displayText('\u202EKNOB')).toBe('KNOB');
    expect(displayText('BO\u200BNK\u0000\n')).toBe('BONK');
    expect(displayText('\u2066pump\u2069')).toBe('pump');
  });
  it('bounds length by code points and tolerates non-strings', () => {
    expect(displayText('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}\u2026`);
    expect(displayText('\u{1F680}'.repeat(5), 3)).toBe('\u{1F680}\u{1F680}\u2026');
    expect(displayText(null)).toBe('');
    expect(displayText({ a: 1 })).toBe('[object Object]');
  });
});
