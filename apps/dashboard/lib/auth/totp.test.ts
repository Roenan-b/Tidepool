import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode } from './base32.js';
import { ReplayGuard, hotp, otpauthUri, timeStep, totp, verifyTotp } from './totp.js';

const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('HOTP (RFC 4226 appendix D)', () => {
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(expected.map((code, counter) => [counter, code]))('counter %i -> %s', (counter, code) => {
    expect(hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238 appendix B, SHA-1, 8 digits)', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  it.each(vectors)('T=%i -> %s', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });

  it('produces 6-digit codes by default (last 6 digits of the 8-digit value)', () => {
    expect(totp(RFC_SECRET, 59_000)).toBe('287082');
  });
});

describe('base32', () => {
  it('matches RFC 4648 test vectors', () => {
    const cases: [string, string][] = [
      ['', ''],
      ['f', 'MY======'],
      ['fo', 'MZXQ===='],
      ['foo', 'MZXW6==='],
      ['foob', 'MZXW6YQ='],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI======'],
    ];
    for (const [plain, enc] of cases) {
      expect(base32Encode(Buffer.from(plain), true)).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
  });

  it('round-trips random secrets and tolerates lower case and spaces', () => {
    for (let i = 0; i < 50; i++) {
      const bytes = Buffer.from(Array.from({ length: 1 + (i % 32) }, (_, j) => (i * 31 + j * 17) & 0xff));
      const enc = base32Encode(bytes);
      expect(base32Decode(enc)).toEqual(bytes);
      expect(base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(bytes);
    }
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('MZXW1')).toThrow();
    expect(() => base32Decode('MZ!W')).toThrow();
  });
});

describe('verifyTotp', () => {
  const secret = RFC_SECRET;
  const now = 1_700_000_000_000;
  const step = timeStep(now);

  it('accepts the current, previous and next step', () => {
    for (const delta of [-1, 0, 1]) {
      const code = hotp(secret, step + delta);
      expect(verifyTotp(secret, code, now, null)).toEqual({ ok: true, step: step + delta });
    }
  });

  it('rejects codes two steps away', () => {
    expect(verifyTotp(secret, hotp(secret, step + 2), now, null).ok).toBe(false);
    expect(verifyTotp(secret, hotp(secret, step - 2), now, null).ok).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(verifyTotp(secret, '12345', now, null)).toEqual({ ok: false, reason: 'format' });
    expect(verifyTotp(secret, 'abcdef', now, null)).toEqual({ ok: false, reason: 'format' });
  });

  it('rejects replay of the same or an older step', () => {
    const code = hotp(secret, step);
    const first = verifyTotp(secret, code, now, null);
    expect(first.ok).toBe(true);
    expect(verifyTotp(secret, code, now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(secret, hotp(secret, step - 1), now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(verifyTotp(secret, hotp(secret, step + 1), now, step).ok).toBe(true);
  });

  it('accepts a code with a space in the middle', () => {
    const code = hotp(secret, step);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now, null).ok).toBe(true);
  });
});

describe('ReplayGuard', () => {
  it('keeps the highest step and evicts oldest users past capacity', () => {
    const g = new ReplayGuard(2);
    g.record('a', 10);
    g.record('a', 5);
    expect(g.lastStep('a')).toBe(10);
    g.record('b', 1);
    g.record('c', 1);
    expect(g.lastStep('a')).toBeNull();
    expect(g.lastStep('c')).toBe(1);
  });
});

describe('otpauthUri', () => {
  it('encodes issuer, account and parameters', () => {
    const uri = otpauthUri(RFC_SECRET, 'jake');
    expect(uri.startsWith('otpauth://totp/Tidepool:jake?')).toBe(true);
    const params = new URL(uri.replace('otpauth://', 'https://')).searchParams;
    expect(params.get('secret')).toBe(base32Encode(RFC_SECRET));
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
    expect(params.get('algorithm')).toBe('SHA1');
  });
});
