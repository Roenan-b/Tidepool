import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './secretBox.js';

const key = randomBytes(32);
const secret = Buffer.from('12345678901234567890');

describe('AES-256-GCM secret box', () => {
  it('round-trips', () => {
    const env = encryptSecret(secret, key, 'user-1');
    expect(env.startsWith('v1.')).toBe(true);
    expect(decryptSecret(env, key, 'user-1')).toEqual(secret);
  });

  it('uses a random IV each time', () => {
    expect(encryptSecret(secret, key, 'u')).not.toBe(encryptSecret(secret, key, 'u'));
  });

  it('detects ciphertext tampering', () => {
    const parts = encryptSecret(secret, key, 'user-1').split('.');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 0x01;
    parts[3] = ct.toString('base64url');
    expect(() => decryptSecret(parts.join('.'), key, 'user-1')).toThrow();
  });

  it('detects tag tampering, a wrong key and a different user (AAD)', () => {
    const env = encryptSecret(secret, key, 'user-1');
    const parts = env.split('.');
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[3] = tag[3]! ^ 0xff;
    expect(() => decryptSecret([parts[0], parts[1], tag.toString('base64url'), parts[3]].join('.'), key, 'user-1')).toThrow();
    expect(() => decryptSecret(env, randomBytes(32), 'user-1')).toThrow();
    expect(() => decryptSecret(env, key, 'user-2')).toThrow();
  });

  it('rejects malformed envelopes and short keys', () => {
    expect(() => decryptSecret('v2.a.b.c', key, 'u')).toThrow();
    expect(() => decryptSecret('nonsense', key, 'u')).toThrow();
    expect(() => encryptSecret(secret, randomBytes(16), 'u')).toThrow();
  });
});
