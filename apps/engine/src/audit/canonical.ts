import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Normalizes a value to the JSON data model that Postgres jsonb will hand back:
 * bigints become decimal strings, Dates become ISO strings, undefined object fields are dropped,
 * non-finite numbers become null. Hashing the normalized form keeps write-time and verify-time
 * hashes identical.
 */
export function normalizeJson(value: unknown): unknown {
  const text = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  return text === undefined ? null : sanitizeStrings(JSON.parse(text));
}

/** NUL and unpaired UTF-16 surrogates: Postgres jsonb rejects both, which would abort the caller's transaction. */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** Replaces characters Postgres cannot store with U+FFFD. Idempotent, so verify-time hashing matches. */
export function storableString(s: string): string {
  return s.replace(UNSTORABLE, '�');
}

function sanitizeStrings(v: unknown): unknown {
  if (typeof v === 'string') return storableString(v);
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sanitizeStrings);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[storableString(k)] = sanitizeStrings(x);
  return out;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace. Input must already be normalized. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface HashableEvent {
  at: string;
  actor: string;
  type: string;
  ref: string | null;
  payload: unknown;
}

/** hash = sha256_hex(prevHash || canonical({at, actor, type, ref, payload})). */
export function eventHash(prevHash: string, e: HashableEvent): string {
  const body = canonicalJson(normalizeJson({ at: e.at, actor: e.actor, type: e.type, ref: e.ref, payload: e.payload }));
  return createHash('sha256').update(prevHash).update(body).digest('hex');
}
