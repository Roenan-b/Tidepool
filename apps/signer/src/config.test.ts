import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { associatedTokenAddress, TOKEN_PROGRAM_ID, WRAPPED_SOL_MINT } from './constants.js';

const owner = Keypair.generate().publicKey.toBase58();
const base = {
  RESERVATION_TICKET_SECRET: 's'.repeat(40),
  SIGNER_API_TOKEN: 't'.repeat(40),
  SIGNER_MAX_PER_TX_LAMPORTS: '500000000',
  SIGNER_MAX_PER_DAY_LAMPORTS: '5000000000',
  SIGNER_MAX_TIP_LAMPORTS: '2000000',
  SIGNER_WITHDRAW_ALLOWLIST: owner,
};

describe('config', () => {
  it('parses a valid environment with loopback defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(7071);
    expect(c.policy.withdrawAllowlist).toEqual([owner]);
    expect(c.policy.maxPerTxLamports).toBe(500_000_000n);
  });

  it('refuses a non-loopback host unless explicitly allowed', () => {
    expect(() => loadConfig({ ...base, SIGNER_HOST: '0.0.0.0' })).toThrow(/not a loopback address/);
    expect(loadConfig({ ...base, SIGNER_HOST: '0.0.0.0', SIGNER_ALLOW_NON_LOOPBACK: 'true' }).host).toBe('0.0.0.0');
  });

  it('validates the withdraw allowlist as wallet addresses', () => {
    expect(() => loadConfig({ ...base, SIGNER_WITHDRAW_ALLOWLIST: 'not-a-key' })).toThrow(
      /not a valid base58 public key/,
    );
    const ata = associatedTokenAddress(Keypair.generate().publicKey, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID).toBase58();
    expect(() => loadConfig({ ...base, SIGNER_WITHDRAW_ALLOWLIST: ata })).toThrow(/off curve/);
  });

  it('rejects short secrets, placeholder values and inconsistent caps', () => {
    expect(() => loadConfig({ ...base, SIGNER_API_TOKEN: 'replace-with-64-hex-chars' })).toThrow(/SIGNER_API_TOKEN/);
    expect(() => loadConfig({ ...base, SIGNER_MAX_PER_TX_LAMPORTS: '9000000000' })).toThrow(/must not exceed/);
    expect(() => loadConfig({ ...base, SIGNER_MAX_TIP_LAMPORTS: '1.5' })).toThrow(/integer number of lamports/);
    expect(() => loadConfig({ ...base, SIGNER_API_TOKEN: base.RESERVATION_TICKET_SECRET })).toThrow(
      /must be different/,
    );
    expect(() => loadConfig({ ...base, SIGNER_PORT: '' })).toThrow(/SIGNER_PORT/);
    expect(() => loadConfig({ ...base, SIGNER_PORT: '0' })).toThrow(/SIGNER_PORT/);
  });
});
