import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair } from '@solana/web3.js';
import {
  MIN_PASSPHRASE_LENGTH,
  createKeystore,
  parseSecretKeyText,
  readKeystorePublicKey,
  writeKeystoreFile,
} from './keystore.js';
import { promptHidden } from './prompt.js';

/**
 * Keystore command line tool.
 *
 *   keystore create [--out <path>]   generate a new hot wallet keypair and write an encrypted keystore
 *   keystore import [--out <path>]   encrypt an existing secret key read from stdin (never from argv)
 *   keystore pubkey [--path <path>]  print the public key of a keystore
 *
 * The passphrase comes from SIGNER_KEYSTORE_PASSPHRASE or an interactive hidden prompt.
 * Only the public key is ever printed.
 */

const DEFAULT_PATH = './keystore/hot-wallet.keystore.json';
const MAX_STDIN_BYTES = 4096;

function usage(): never {
  process.stderr.write('usage: keystore <create|import|pubkey> [--out <path>] [--path <path>]\n');
  process.exit(2);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) usage();
  return v;
}

async function readPassphrase(confirm: boolean): Promise<string> {
  const fromEnv = process.env.SIGNER_KEYSTORE_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const first = await promptHidden('Keystore passphrase: ');
  if (first.length < MIN_PASSPHRASE_LENGTH)
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  if (confirm) {
    const second = await promptHidden('Repeat passphrase: ');
    if (second !== first) throw new Error('passphrases do not match');
  }
  return first;
}

async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) return promptHidden('Secret key (base58 or JSON array): ');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > MAX_STDIN_BYTES) throw new Error('stdin input too large for a secret key');
    chunks.push(buf);
  }
  const all = Buffer.concat(chunks);
  const text = all.toString('utf8');
  all.fill(0);
  for (const c of chunks) c.fill(0);
  return text;
}

function writeNew(path: string, secret: Uint8Array, passphrase: string): string {
  if (existsSync(path)) throw new Error(`refusing to overwrite existing keystore at ${path}`);
  const ks = createKeystore(secret, passphrase);
  writeKeystoreFile(path, ks);
  return ks.publicKey;
}

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const envPath = process.env.SIGNER_KEYSTORE_PATH || DEFAULT_PATH;
  switch (command) {
    case 'create': {
      const out = resolve(argValue(rest, '--out') ?? envPath);
      if (existsSync(out)) throw new Error(`refusing to overwrite existing keystore at ${out}`);
      const passphrase = await readPassphrase(true);
      const secret = Keypair.generate().secretKey; // getter returns a copy
      try {
        const pub = writeNew(out, secret, passphrase);
        process.stdout.write(`${pub}\n`);
      } finally {
        secret.fill(0);
      }
      return 0;
    }
    case 'import': {
      const out = resolve(argValue(rest, '--out') ?? envPath);
      if (existsSync(out)) throw new Error(`refusing to overwrite existing keystore at ${out}`);
      if (!process.stdin.isTTY && !process.env.SIGNER_KEYSTORE_PASSPHRASE) {
        throw new Error('set SIGNER_KEYSTORE_PASSPHRASE when piping the secret key on stdin');
      }
      const text = await readSecretFromStdin();
      const secret = parseSecretKeyText(text);
      try {
        const passphrase = await readPassphrase(true);
        const pub = writeNew(out, secret, passphrase);
        process.stdout.write(`${pub}\n`);
      } finally {
        secret.fill(0);
      }
      return 0;
    }
    case 'pubkey': {
      const path = resolve(argValue(rest, '--path') ?? envPath);
      process.stdout.write(`${readKeystorePublicKey(path)}\n`);
      return 0;
    }
    default:
      usage();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Error messages in this tool never contain key material.
      process.stderr.write(`error: ${err instanceof Error ? err.message : 'unknown failure'}\n`);
      process.exit(1);
    },
  );
}
