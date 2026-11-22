/**
 * Dashboard user administration.
 *
 *   npm run create-user -w @tidepool/dashboard -- create --username jake --role owner
 *   npm run create-user -w @tidepool/dashboard -- reset-totp --username jake
 *   npm run create-user -w @tidepool/dashboard -- unlock --username jake
 *
 * The password is read from stdin (hidden when stdin is a terminal), never from argv, so it does
 * not land in shell history or the process list. Requires DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { hashPassword, passwordPolicyError } from '../lib/auth/password.js';

type Command = 'create' | 'reset-totp' | 'unlock';

export interface CliArgs {
  command: Command;
  username: string;
  role: 'owner' | 'operator' | null;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (command !== 'create' && command !== 'reset-totp' && command !== 'unlock') {
    throw new Error('usage: createUser.ts <create|reset-totp|unlock> --username <name> [--role owner|operator]');
  }
  let username: string | null = null;
  let role: CliArgs['role'] = null;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === '--username' && value) {
      username = value;
      i++;
    } else if (flag === '--role' && value) {
      if (value !== 'owner' && value !== 'operator') throw new Error('--role must be owner or operator');
      role = value;
      i++;
    } else if (flag === '--password' || flag?.startsWith('--password=')) {
      throw new Error('passwords are read from stdin only, never from arguments');
    } else {
      throw new Error(`unknown argument: ${String(flag)}`);
    }
  }
  if (!username || !/^[A-Za-z0-9_.-]{1,64}$/.test(username))
    throw new Error('--username is required (letters, digits, _ . -)');
  if (command === 'create' && !role) throw new Error('--role is required for create');
  return { command, username, role };
}

/** Reads one line from stdin. On a terminal, echo is disabled while typing. */
async function readSecretLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          reject(new Error('cancelled'));
          return;
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: url, statement_timeout: 10_000 });
  await client.connect();
  try {
    if (args.command === 'create') {
      const password = await readSecretLine(`Password for ${args.username}: `);
      const policy = passwordPolicyError(password);
      if (policy) throw new Error(policy);
      if (process.stdin.isTTY) {
        const again = await readSecretLine('Repeat password: ');
        if (again !== password) throw new Error('passwords do not match');
      }
      const hash = await hashPassword(password);
      const r = await client.query(
        `INSERT INTO auth_users (id, username, role, password_hash) VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [randomUUID(), args.username, args.role, hash],
      );
      if ((r.rowCount ?? 0) === 0) throw new Error(`user ${args.username} already exists`);
      console.log(`Created ${String(args.role)} ${args.username}. They must enroll two-factor sign-in at first login.`);
    } else if (args.command === 'reset-totp') {
      const r = await client.query(
        'UPDATE auth_users SET totp_secret_enc = NULL, totp_enabled = false WHERE username = $1',
        [args.username],
      );
      if ((r.rowCount ?? 0) === 0) throw new Error(`no user ${args.username}`);
      await client.query('DELETE FROM auth_sessions WHERE user_id = (SELECT id FROM auth_users WHERE username = $1)', [
        args.username,
      ]);
      console.log(`Two-factor sign-in reset for ${args.username}; existing sessions ended.`);
    } else {
      const r = await client.query(
        'UPDATE auth_users SET failed_attempts = 0, locked_until = NULL WHERE username = $1',
        [args.username],
      );
      if ((r.rowCount ?? 0) === 0) throw new Error(`no user ${args.username}`);
      console.log(`Unlocked ${args.username}.`);
    }
  } finally {
    await client.end();
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err: unknown) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
