import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';
import { base58Decode, base58Encode } from './base58.js';
import {
  createKeystore,
  decryptKeystore,
  loadKeystore,
  parseKeystore,
  parseSecretKeyText,
  readKeystorePublicKey,
  writeKeystoreFile,
} from './keystore.js';

const dir = mkdtempSync(join(tmpdir(), 'signer-keystore-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PASS = 'correct horse battery staple';
const FAST = { scryptN: 1 << 14 }; // minimum accepted cost, keeps tests quick

function fresh(name: string) {
  const kp = Keypair.generate();
  const path = join(dir, name);
  writeKeystoreFile(path, createKeystore(kp.secretKey, PASS, FAST));
  return { kp, path };
}

describe('keystore', () => {
  it('round trips a keypair and writes the file with mode 0600', () => {
    const { kp, path } = fresh('roundtrip.json');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    const loaded = loadKeystore(path, PASS);
    expect(loaded.publicKey.equals(kp.publicKey)).toBe(true);
    expect(Buffer.from(loaded.secretKey).equals(Buffer.from(kp.secretKey))).toBe(true);
    expect(readKeystorePublicKey(path)).toBe(kp.publicKey.toBase58());
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(base58Encode(kp.secretKey));
  });

  it('fails with a generic error on a wrong passphrase', () => {
    const { path } = fresh('wrongpass.json');
    expect(() => loadKeystore(path, 'not the right passphrase')).toThrow(/unable to decrypt keystore/);
  });

  it('rejects a tampered ciphertext and a tampered header', () => {
    const { path } = fresh('tamper.json');
    const ks = parseKeystore(readFileSync(path, 'utf8'));
    const ct = Buffer.from(ks.cipher.ciphertext, 'base64');
    ct[0] = ct[0]! ^ 0x01;
    expect(() => decryptKeystore({ ...ks, cipher: { ...ks.cipher, ciphertext: ct.toString('base64') } }, PASS)).toThrow(
      /unable to decrypt keystore/,
    );
    const otherPub = Keypair.generate().publicKey.toBase58();
    expect(() => decryptKeystore({ ...ks, publicKey: otherPub }, PASS)).toThrow(/unable to decrypt keystore/);
  });

  it('refuses a keystore readable by group or other', () => {
    if (process.platform === 'win32') return;
    const { path } = fresh('open.json');
    chmodSync(path, 0o644);
    expect(() => loadKeystore(path, PASS)).toThrow(/permissions are too open/);
    chmodSync(path, 0o640);
    expect(() => loadKeystore(path, PASS)).toThrow(/permissions are too open/);
  });

  it('refuses to overwrite an existing keystore', () => {
    const { path } = fresh('exists.json');
    expect(() => writeKeystoreFile(path, createKeystore(Keypair.generate().secretKey, PASS, FAST))).toThrow();
  });

  it('enforces a minimum passphrase length', () => {
    expect(() => createKeystore(Keypair.generate().secretKey, 'short', FAST)).toThrow(/at least 12/);
  });

  it('rejects malformed or out-of-bounds keystore files', () => {
    const { path } = fresh('bounds.json');
    const ks = JSON.parse(readFileSync(path, 'utf8'));
    ks.kdf.N = 1 << 24;
    const bad = join(dir, 'bounds-bad.json');
    writeFileSync(bad, JSON.stringify(ks), { mode: 0o600 });
    expect(() => loadKeystore(bad, PASS)).toThrow(/invalid format/);
  });

  it('parses exported secret keys in base58 and JSON array form', () => {
    const kp = Keypair.generate();
    expect(Buffer.from(parseSecretKeyText(base58Encode(kp.secretKey))).equals(Buffer.from(kp.secretKey))).toBe(true);
    expect(
      Buffer.from(parseSecretKeyText(JSON.stringify(Array.from(kp.secretKey)))).equals(Buffer.from(kp.secretKey)),
    ).toBe(true);
    expect(() => parseSecretKeyText('[1,2,3]')).toThrow(/64 byte values/);
    expect(() => parseSecretKeyText('0OIl')).toThrow(/base58/);
  });

  it('base58 codec round trips, including leading zeros', () => {
    const samples = [new Uint8Array([0, 0, 1, 2, 3]), new Uint8Array(32), Keypair.generate().secretKey];
    for (const s of samples) expect(Buffer.from(base58Decode(base58Encode(s))).equals(Buffer.from(s))).toBe(true);
    const pk = Keypair.generate().publicKey;
    expect(base58Encode(pk.toBytes())).toBe(pk.toBase58());
  });
});
