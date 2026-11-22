import { randomBytes } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
  associatedTokenAddress,
} from '../constants.js';
import type { PolicyConfig, TicketForPolicy } from '../policy.js';

/** Test-only helpers. All keys are ephemeral, created fresh on every run; nothing here touches a network. */

export const FAKE_BLOCKHASH = new PublicKey(randomBytes(32)).toBase58();
export const TIP_ACCOUNT = Keypair.generate().publicKey;
export const OWNER_WALLET = Keypair.generate().publicKey; // stands in for the allowlisted withdrawal wallet
export const ATTACKER = Keypair.generate().publicKey;
export const MEME_MINT = Keypair.generate().publicKey;

export function policyConfig(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    allowedProgramIds: [],
    tipAccounts: [TIP_ACCOUNT.toBase58()],
    withdrawAllowlist: [OWNER_WALLET.toBase58()],
    maxPerTxLamports: 500_000_000n,
    maxTipLamports: 2_000_000n,
    ...overrides,
  };
}

export function buyTicket(overrides: Partial<TicketForPolicy> = {}): TicketForPolicy {
  return { intent: 'buy', maxLamports: '150000000', maxTipLamports: '2000000', destination: null, mint: MEME_MINT.toBase58(), ...overrides };
}

export function wsolAta(wallet: PublicKey): PublicKey {
  return associatedTokenAddress(wallet, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID);
}

export function transfer(from: PublicKey, to: PublicKey, lamports: bigint): TransactionInstruction {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

export function computeBudget(units: number, microLamports: number): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export function tokenIx(data: number[], keys: { pubkey: PublicKey; isSigner?: boolean; isWritable?: boolean }[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner ?? false, isWritable: k.isWritable ?? true })),
    data: Buffer.from(data),
  });
}

export function syncNative(account: PublicKey): TransactionInstruction {
  return tokenIx([17], [{ pubkey: account }]);
}

export function closeAccount(account: PublicKey, destination: PublicKey, owner: PublicKey): TransactionInstruction {
  return tokenIx([9], [{ pubkey: account }, { pubkey: destination }, { pubkey: owner, isSigner: true, isWritable: false }]);
}

/** Opaque route instruction shaped like a Jupiter swap: wallet as signer plus several pool accounts. */
export function jupiterRoute(wallet: PublicKey, mint: PublicKey): TransactionInstruction {
  const pools = Array.from({ length: 6 }, () => Keypair.generate().publicKey);
  return new TransactionInstruction({
    programId: JUPITER_V6_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: wsolAta(wallet), isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(wallet, mint, TOKEN_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      ...pools.map((p) => ({ pubkey: p, isSigner: false, isWritable: true })),
    ],
    data: randomBytes(40),
  });
}

/** A realistic buy: budget, create WSOL ATA, wrap, sync, route, create output ATA, unwrap, tip. */
export function buyInstructions(wallet: PublicKey, opts: { wrapLamports?: bigint; tipLamports?: bigint; microLamports?: number } = {}): TransactionInstruction[] {
  const ata = wsolAta(wallet);
  return [
    ...computeBudget(200_000, opts.microLamports ?? 1_000),
    createAtaIdempotent(wallet, wallet, WRAPPED_SOL_MINT),
    createAtaIdempotent(wallet, wallet, MEME_MINT),
    transfer(wallet, ata, opts.wrapLamports ?? 100_000_000n),
    syncNative(ata),
    jupiterRoute(wallet, MEME_MINT),
    closeAccount(ata, wallet, wallet),
    transfer(wallet, TIP_ACCOUNT, opts.tipLamports ?? 1_000_000n),
  ];
}

export function v0(payer: PublicKey, instructions: TransactionInstruction[], tables: AddressLookupTableAccount[] = []): VersionedTransaction {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: FAKE_BLOCKHASH, instructions }).compileToV0Message(tables);
  return new VersionedTransaction(message);
}

export function legacy(payer: PublicKey, instructions: TransactionInstruction[]): Transaction {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: FAKE_BLOCKHASH });
  tx.add(...instructions);
  return tx;
}

export function toBase64(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64');
}
