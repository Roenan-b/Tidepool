/**
 * Display formatting for lamport amounts and USD. Pure and safe for client components.
 * Ledger amounts stay integers: lamports as bigint, USD as integer cents. The SOL/USD price is a
 * float from the engine; it is converted once to integer micro-dollars and all math after that is bigint.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export function toLamports(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (!/^-?\d+$/.test(value)) throw new RangeError(`not an integer lamport string: ${value}`);
  return BigInt(value);
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Rounds half away from zero when dividing a bigint. */
function divRound(n: bigint, d: bigint): bigint {
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an + ad / 2n) / ad;
  return neg ? -q : q;
}

/** "1.2345 SOL" style. `fractionDigits` 0..9; rounds to the nearest displayed unit. */
export function formatSol(lamports: string | bigint, fractionDigits = 4, opts: { signed?: boolean; unit?: boolean } = {}): string {
  const l = toLamports(lamports);
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 9) throw new RangeError('fractionDigits');
  const scale = 10n ** BigInt(9 - fractionDigits);
  const rounded = divRound(l, scale);
  const neg = rounded < 0n;
  const abs = neg ? -rounded : rounded;
  const unitsPerSol = 10n ** BigInt(fractionDigits);
  const whole = groupThousands((abs / unitsPerSol).toString());
  const frac = fractionDigits > 0 ? '.' + (abs % unitsPerSol).toString().padStart(fractionDigits, '0') : '';
  const sign = neg ? '-' : opts.signed && abs > 0n ? '+' : '';
  return `${sign}${whole}${frac}${opts.unit === false ? '' : ' SOL'}`;
}

/** Converts lamports to integer USD cents at the given SOL price. Returns null when price is unknown. */
export function lamportsToUsdCents(lamports: string | bigint, solUsd: number | null): bigint | null {
  if (solUsd === null || !Number.isFinite(solUsd) || solUsd < 0) return null;
  const microUsdPerSol = BigInt(Math.round(solUsd * 1_000_000));
  // lamports * microUSD/SOL / 1e9 lamports/SOL = microUSD; / 1e4 = cents
  return divRound(toLamports(lamports) * microUsdPerSol, LAMPORTS_PER_SOL * 10_000n);
}

export function formatUsdCents(cents: bigint, opts: { signed?: boolean } = {}): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const body = `$${groupThousands((abs / 100n).toString())}.${(abs % 100n).toString().padStart(2, '0')}`;
  if (neg) return `-${body}`;
  return opts.signed && abs > 0n ? `+${body}` : body;
}

/** "$1,234.56", or null when the price is unknown. */
export function formatLamportsUsd(lamports: string | bigint, solUsd: number | null, opts: { signed?: boolean } = {}): string | null {
  const cents = lamportsToUsdCents(lamports, solUsd);
  return cents === null ? null : formatUsdCents(cents, opts);
}

/** Whole-dollar USD for limits and targets: "$150". */
export function formatUsdWhole(usd: number, opts: { signed?: boolean } = {}): string {
  const rounded = Math.round(usd);
  const neg = rounded < 0;
  const body = `$${groupThousands(String(Math.abs(rounded)))}`;
  if (neg) return `-${body}`;
  return opts.signed && rounded > 0 ? `+${body}` : body;
}

/**
 * Parses a user-typed SOL amount ("1.5", "0.000000001") into lamports without floating point.
 * Returns null for anything that is not a positive decimal with at most 9 fraction digits.
 */
export function parseSolInput(input: string): bigint | null {
  const s = input.trim().replace(/,/g, '');
  const m = /^(\d{0,12})(?:\.(\d{0,9}))?$/.exec(s);
  if (!m || s === '' || s === '.') return null;
  const whole = BigInt(m[1] || '0');
  const frac = BigInt((m[2] ?? '').padEnd(9, '0') || '0');
  const lamports = whole * LAMPORTS_PER_SOL + frac;
  return lamports > 0n ? lamports : null;
}

export function formatPct(ratio: number | null, digits = 1): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'n/a';
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;
}

export function formatAge(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'no data';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export function shortAddress(address: string, keep = 4): string {
  return address.length <= keep * 2 + 1 ? address : `${address.slice(0, keep)}...${address.slice(-keep)}`;
}

export function formatTime(iso: string | null): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'n/a';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Prepares untrusted text (token symbols and other on-chain or social metadata relayed by the engine)
 * for display. React already escapes markup; this removes control, bidirectional-override and
 * zero-width characters, which can make one token's name render like another's, and bounds the length.
 */
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001F\u007F-\u009F؜​-‏‪-‮⁠-⁩﻿]/g;

export function displayText(value: unknown, maxChars = 64): string {
  if (value === null || value === undefined) return '';
  const clean = String(value).replace(UNSAFE_DISPLAY_CHARS, '');
  const chars = [...clean];
  return chars.length > maxChars ? `${chars.slice(0, maxChars - 1).join('')}…` : clean;
}
