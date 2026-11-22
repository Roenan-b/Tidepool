/** RFC 4648 base32 (upper-case alphabet), used for TOTP shared secrets. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOKUP: Record<string, number> = Object.fromEntries(Array.from(ALPHABET).map((c, i) => [c, i]));

/** Encodes bytes as base32. Padding is omitted by default, as authenticator apps expect. */
export function base32Encode(data: Uint8Array, padding = false): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of data) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(buffer >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31]!;
  if (padding) while (out.length % 8 !== 0) out += '=';
  return out;
}

/**
 * Decodes base32. Accepts lower case, spaces and trailing padding (as users type secrets by hand).
 * Throws on any other character or on non-zero trailing bits.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = LOOKUP[ch];
    if (v === undefined) throw new Error('invalid base32 character');
    buffer = (buffer << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits >= 5 || buffer !== 0) throw new Error('invalid base32 length or trailing bits');
  return Buffer.from(bytes);
}
