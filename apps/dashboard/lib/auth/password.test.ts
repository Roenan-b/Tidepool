import { describe, expect, it } from 'vitest';
import { hashPassword, parsePasswordHash, passwordPolicyError, verifyPassword } from './password.js';

const FAST = { N: 1024, r: 8, p: 1 };

describe('scrypt password hashing', () => {
  it('stores scrypt$N$r$p$salt$hash and verifies the right password', async () => {
    const h = await hashPassword('correct horse battery staple', FAST);
    expect(h).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const h = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery stapl', h)).toBe(false);
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('uses a fresh salt per hash', async () => {
    const a = await hashPassword('same password here', FAST);
    const b = await hashPassword('same password here', FAST);
    expect(a).not.toBe(b);
  });

  it('verifies with the default (production) parameters', async () => {
    const h = await hashPassword('a much longer passphrase');
    expect(h.startsWith('scrypt$65536$8$1$')).toBe(true);
    expect(await verifyPassword('a much longer passphrase', h)).toBe(true);
  });

  it('refuses malformed or abusive stored hashes', async () => {
    expect(parsePasswordHash('bcrypt$x')).toBeNull();
    expect(parsePasswordHash('scrypt$1000$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==')).toBeNull(); // N not a power of 2
    expect(parsePasswordHash('scrypt$2097152$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==')).toBeNull(); // N too large
    expect(await verifyPassword('anything', 'garbage')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(passwordPolicyError('short')).not.toBeNull();
    expect(passwordPolicyError(' leading space ok?')).not.toBeNull();
    expect(passwordPolicyError('twelve chars!')).toBeNull();
  });
});
