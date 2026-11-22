import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';
import { base58Encode } from './base58.js';
import { loadKeystore } from './keystore.js';

const dir = mkdtempSync(join(tmpdir(), 'signer-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TSX = resolve(__dirname, '../../../node_modules/.bin/tsx');
const CLI = resolve(__dirname, 'keystoreCli.ts');
const PASS = 'cli test passphrase 123';

function cli(args: string[], input: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  return spawnSync(TSX, [CLI, ...args], { input, env, encoding: 'utf8', timeout: 60_000 });
}

describe('keystore cli', () => {
  it('imports a piped secret key and prints only the public key', () => {
    const kp = Keypair.generate();
    const secret = base58Encode(kp.secretKey);
    const out = join(dir, 'imported.json');
    const res = cli(['import', '--out', out], `${secret}\n`, { SIGNER_KEYSTORE_PASSPHRASE: PASS });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout.trim()).toBe(kp.publicKey.toBase58());
    expect(res.stdout + res.stderr).not.toContain(secret);
    if (process.platform !== 'win32') expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(loadKeystore(out, PASS).publicKey.equals(kp.publicKey)).toBe(true);

    const pub = cli(['pubkey', '--path', out], '');
    expect(pub.stdout.trim()).toBe(kp.publicKey.toBase58());

    const again = cli(['import', '--out', out], `${secret}\n`, { SIGNER_KEYSTORE_PASSPHRASE: PASS });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/refusing to overwrite/);
  });

  it('refuses a piped import without a passphrase in the environment', () => {
    const res = cli(['import', '--out', join(dir, 'nopass.json')], base58Encode(Keypair.generate().secretKey));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/SIGNER_KEYSTORE_PASSPHRASE/);
  });
});
