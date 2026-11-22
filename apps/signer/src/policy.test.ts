import {
  AddressLookupTableAccount,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  JUPITER_V6_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
  associatedTokenAddress,
} from './constants.js';
import { evaluatePolicy, type PolicyConfig, type TicketForPolicy } from './policy.js';
import {
  ATTACKER,
  FAKE_BLOCKHASH,
  MEME_MINT,
  OWNER_WALLET,
  TIP_ACCOUNT,
  buyInstructions,
  buyTicket,
  closeAccount,
  computeBudget,
  createAtaIdempotent,
  legacy,
  policyConfig,
  tokenIx,
  toBase64,
  transfer,
  v0,
  wsolAta,
} from './test/fixtures.js';

const wallet = Keypair.generate().publicKey;

function run(
  transaction: Parameters<typeof evaluatePolicy>[0]['transaction'],
  ticket: TicketForPolicy = buyTicket(),
  config: PolicyConfig = policyConfig(),
) {
  return evaluatePolicy({ transaction, wallet, ticket, config });
}

function expectDenied(decision: ReturnType<typeof run>, pattern: RegExp): void {
  expect(decision.allow).toBe(false);
  expect(
    decision.reasons.some((r) => pattern.test(r)),
    `reasons: ${decision.reasons.join(' | ')}`,
  ).toBe(true);
}

const withdrawTicket = (destination: string, maxLamports = '1000000000'): TicketForPolicy => ({
  intent: 'withdraw',
  maxLamports,
  maxTipLamports: '0',
  destination,
  mint: null,
});

describe('policy: allowed transactions', () => {
  it('allows a realistic Jupiter-style buy as a v0 transaction', () => {
    const d = run(v0(wallet, buyInstructions(wallet)));
    expect(d.reasons).toEqual([]);
    expect(d.allow).toBe(true);
    expect(d.spendLamports).toBe(100_000_000n);
    expect(d.tipLamports).toBe(1_000_000n);
    expect(d.priorityFeeLamports).toBe(200n); // 1000 microLamports * 200k units / 1e6
  });

  it('allows the same buy as a legacy transaction object and as base64 wire bytes', () => {
    const tx = legacy(wallet, buyInstructions(wallet));
    expect(run(tx).allow).toBe(true);
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    const d = run(wire);
    expect(d.allow).toBe(true);
    expect(d.spendLamports).toBe(100_000_000n);
  });

  it('accepts v0 transactions whose non-checked accounts come from a lookup table', () => {
    const pool = Keypair.generate().publicKey;
    const route = new TransactionInstruction({
      programId: JUPITER_V6_PROGRAM_ID,
      keys: [
        { pubkey: wallet, isSigner: true, isWritable: true },
        { pubkey: pool, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1, 2, 3]),
    });
    const table = lookupTable([pool]);
    const tx = v0(wallet, [...computeBudget(100_000, 0), route], [table]);
    expect(tx.message.addressTableLookups.length).toBe(1);
    expect(run(tx).allow).toBe(true);
  });

  it('allows a sell with only a tip and an unwrap to the wallet', () => {
    const ata = wsolAta(wallet);
    const ixs = [
      ...computeBudget(200_000, 1_000),
      createAtaIdempotent(wallet, wallet, WRAPPED_SOL_MINT),
      transfer(wallet, TIP_ACCOUNT, 500_000n),
      closeAccount(ata, wallet, wallet),
    ];
    const d = run(v0(wallet, ixs), buyTicket({ intent: 'sell', maxLamports: '0' }));
    expect(d.reasons).toEqual([]);
    expect(d.spendLamports).toBe(0n);
  });

  it('allows a withdraw to the allowlisted destination named in the ticket', () => {
    const d = run(v0(wallet, [transfer(wallet, OWNER_WALLET, 300_000_000n)]), withdrawTicket(OWNER_WALLET.toBase58()));
    expect(d.reasons).toEqual([]);
    expect(d.spendLamports).toBe(300_000_000n);
  });

  it('allows CreateAccountWithSeed funding a token account within the rent limit', async () => {
    const seed = 'tmpwsol1';
    const newAccount = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID);
    const ix = SystemProgram.createAccountWithSeed({
      fromPubkey: wallet,
      basePubkey: wallet,
      seed,
      newAccountPubkey: newAccount,
      lamports: 2_039_280,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    });
    const init3 = tokenIx(
      [18, ...wallet.toBytes()],
      [{ pubkey: newAccount }, { pubkey: WRAPPED_SOL_MINT, isWritable: false }],
    );
    const d = run(v0(wallet, [ix, init3, closeAccount(newAccount, wallet, wallet)]));
    expect(d.reasons).toEqual([]);
    expect(d.spendLamports).toBe(2_039_280n);
  });

  it('allows top-level token transfers only when explicitly configured', () => {
    const src = associatedTokenAddress(wallet, MEME_MINT, TOKEN_PROGRAM_ID);
    const ix = tokenIx(
      [3, 1, 0, 0, 0, 0, 0, 0, 0],
      [
        { pubkey: src },
        { pubkey: Keypair.generate().publicKey },
        { pubkey: wallet, isSigner: true, isWritable: false },
      ],
    );
    expectDenied(run(v0(wallet, [ix])), /top-level token Transfer is not allowed/);
    expect(run(v0(wallet, [ix]), buyTicket(), policyConfig({ allowTopLevelTokenTransfers: true })).allow).toBe(true);
  });
});

function lookupTable(addresses: PublicKey[]): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses,
    },
  });
}

describe('policy: denials', () => {
  it('denies an unknown program', () => {
    const rogue = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [{ pubkey: wallet, isSigner: true, isWritable: true }],
      data: Buffer.from([0]),
    });
    expectDenied(run(v0(wallet, [...buyInstructions(wallet), rogue])), /program .* is not allowed/);
  });

  it('denies a SOL transfer to an attacker', () => {
    expectDenied(
      run(v0(wallet, [...buyInstructions(wallet), transfer(wallet, ATTACKER, 1n)])),
      /unapproved destination/,
    );
  });

  it('denies a wrap larger than the ticket allows', () => {
    expectDenied(run(v0(wallet, buyInstructions(wallet, { wrapLamports: 150_000_001n }))), /exceeds ticket maximum/);
  });

  it('denies a wrap larger than the per-transaction cap', () => {
    const ticket = buyTicket({ maxLamports: '900000000' });
    expectDenied(
      run(v0(wallet, buyInstructions(wallet, { wrapLamports: 600_000_000n })), ticket),
      /per-transaction cap/,
    );
  });

  it('denies a tip above the cap (config and ticket)', () => {
    expectDenied(
      run(v0(wallet, buyInstructions(wallet, { tipLamports: 2_000_001n }))),
      /tips 2000001 exceed cap 2000000/,
    );
    expectDenied(
      run(v0(wallet, buyInstructions(wallet, { tipLamports: 1_000_000n })), buyTicket({ maxTipLamports: '999999' })),
      /tips .* exceed cap 999999/,
    );
  });

  it('denies when the fee payer is not the wallet', () => {
    const other = Keypair.generate().publicKey;
    expectDenied(run(v0(other, buyInstructions(wallet))), /fee payer is not the wallet/);
  });

  it('denies an extra required signer', () => {
    const cosigner = Keypair.generate().publicKey;
    const ix = new TransactionInstruction({
      programId: JUPITER_V6_PROGRAM_ID,
      keys: [{ pubkey: cosigner, isSigner: true, isWritable: false }],
      data: Buffer.from([0]),
    });
    expectDenied(run(v0(wallet, [...buyInstructions(wallet), ix])), /requires 2 signatures/);
  });

  it('denies token SetAuthority', () => {
    const acct = associatedTokenAddress(wallet, MEME_MINT, TOKEN_PROGRAM_ID);
    const ix = tokenIx(
      [6, 2, 1, ...ATTACKER.toBytes()],
      [{ pubkey: acct }, { pubkey: wallet, isSigner: true, isWritable: false }],
    );
    expectDenied(run(v0(wallet, [...buyInstructions(wallet), ix])), /SetAuthority is not allowed/);
  });

  it('denies token Approve and ApproveChecked', () => {
    const acct = associatedTokenAddress(wallet, MEME_MINT, TOKEN_PROGRAM_ID);
    const approve = tokenIx(
      [4, 255, 255, 255, 255, 0, 0, 0, 0],
      [
        { pubkey: acct },
        { pubkey: ATTACKER, isWritable: false },
        { pubkey: wallet, isSigner: true, isWritable: false },
      ],
    );
    expectDenied(run(v0(wallet, [approve])), /delegation \(Approve\)/);
    const checked = tokenIx(
      [13, 1, 0, 0, 0, 0, 0, 0, 0, 6],
      [
        { pubkey: acct },
        { pubkey: MEME_MINT, isWritable: false },
        { pubkey: ATTACKER, isWritable: false },
        { pubkey: wallet, isSigner: true, isWritable: false },
      ],
    );
    expectDenied(run(v0(wallet, [checked])), /delegation \(ApproveChecked\)/);
  });

  it('denies CloseAccount to an attacker', () => {
    const ixs = buyInstructions(wallet);
    ixs.splice(ixs.length - 2, 1, closeAccount(wsolAta(wallet), ATTACKER, wallet));
    expectDenied(run(v0(wallet, ixs)), /CloseAccount destination .* is not the wallet/);
  });

  it('denies system Assign, Allocate and nonce instructions', () => {
    expectDenied(
      run(v0(wallet, [SystemProgram.assign({ accountPubkey: wallet, programId: ATTACKER })])),
      /Assign is not allowed/,
    );
    expectDenied(
      run(v0(wallet, [SystemProgram.allocate({ accountPubkey: wallet, space: 10 })])),
      /Allocate is not allowed/,
    );
    const nonce = Keypair.generate().publicKey;
    expectDenied(
      run(v0(wallet, [SystemProgram.nonceAdvance({ noncePubkey: nonce, authorizedPubkey: wallet })])),
      /AdvanceNonceAccount is not allowed/,
    );
  });

  it('denies a withdraw to an address that is not allowlisted', () => {
    const d = run(v0(wallet, [transfer(wallet, ATTACKER, 1_000n)]), withdrawTicket(ATTACKER.toBase58()));
    expectDenied(d, /not on the allowlist/);
    expectDenied(d, /unapproved destination/);
  });

  it('denies a withdraw whose transaction destination differs from the ticket destination', () => {
    const second = Keypair.generate().publicKey;
    const config = policyConfig({ withdrawAllowlist: [OWNER_WALLET.toBase58(), second.toBase58()] });
    expectDenied(
      run(v0(wallet, [transfer(wallet, second, 1_000n)]), withdrawTicket(OWNER_WALLET.toBase58()), config),
      /unapproved destination/,
    );
  });

  it('denies a withdraw that also uses Jupiter', () => {
    const ixs = [transfer(wallet, OWNER_WALLET, 1_000n), buyInstructions(wallet)[6]!];
    expectDenied(
      run(v0(wallet, ixs), withdrawTicket(OWNER_WALLET.toBase58())),
      /only use the System and Compute Budget/,
    );
  });

  it('denies a sell that moves SOL out (wrap)', () => {
    expectDenied(
      run(v0(wallet, buyInstructions(wallet)), buyTicket({ intent: 'sell' })),
      /sell transactions may not transfer SOL/,
    );
  });

  it('denies a priority fee above the cap', () => {
    // 100,000,000 microLamports * 200,000 units / 1e6 = 20,000,000 lamports
    expectDenied(
      run(v0(wallet, buyInstructions(wallet, { microLamports: 100_000_000 }))),
      /priority fee 20000000 exceeds cap/,
    );
  });

  it('uses the runtime default compute limit when no limit is set', () => {
    const price = new TransactionInstruction({
      programId: computeBudget(1, 1)[1]!.programId,
      keys: [],
      data: Buffer.from([3, 0x80, 0x96, 0x98, 0, 0, 0, 0, 0]),
    }); // 10,000,000 microLamports
    const d = run(v0(wallet, [price, transfer(wallet, TIP_ACCOUNT, 1n)]));
    expect(d.priorityFeeLamports).toBe(2_000_000n); // 200k default units * 10M / 1e6
  });

  it('denies a program id resolved through an address lookup table', () => {
    const table = Keypair.generate().publicKey;
    const message = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
      staticAccountKeys: [wallet],
      recentBlockhash: FAKE_BLOCKHASH,
      compiledInstructions: [{ programIdIndex: 1, accountKeyIndexes: [0], data: new Uint8Array([1]) }],
      addressTableLookups: [{ accountKey: table, writableIndexes: [], readonlyIndexes: [0] }],
    });
    const wire = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
    expectDenied(run(wire), /program id is resolved from an address lookup table/);
  });

  it('denies a transfer whose destination comes from an address lookup table', () => {
    const tx = v0(wallet, buyInstructions(wallet), [lookupTable([TIP_ACCOUNT])]);
    expectDenied(run(toBase64(tx)), /transfer destination account comes from an address lookup table/);
  });

  it('denies CreateAccountWithSeed above the rent limit or for a non-token owner', async () => {
    const seed = 'big';
    const tokenAcct = await PublicKey.createWithSeed(wallet, seed, TOKEN_PROGRAM_ID);
    const big = SystemProgram.createAccountWithSeed({
      fromPubkey: wallet,
      basePubkey: wallet,
      seed,
      newAccountPubkey: tokenAcct,
      lamports: 50_000_000,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    });
    expectDenied(run(v0(wallet, [big])), /exceeds rent limit/);
    const sysAcct = await PublicKey.createWithSeed(wallet, seed, SYSTEM_PROGRAM_ID);
    const wrongOwner = SystemProgram.createAccountWithSeed({
      fromPubkey: wallet,
      basePubkey: wallet,
      seed,
      newAccountPubkey: sysAcct,
      lamports: 1_000,
      space: 0,
      programId: SYSTEM_PROGRAM_ID,
    });
    expectDenied(run(v0(wallet, [wrongOwner])), /may only create Token or Token-2022 accounts/);
    const mismatch = SystemProgram.createAccountWithSeed({
      fromPubkey: wallet,
      basePubkey: wallet,
      seed,
      newAccountPubkey: ATTACKER,
      lamports: 1_000,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    });
    expectDenied(run(v0(wallet, [mismatch])), /does not match its seed derivation/);
  });

  it('denies token accounts initialised for, or ATAs created for, another owner', () => {
    const acct = Keypair.generate().publicKey;
    expectDenied(
      run(
        v0(wallet, [
          tokenIx([18, ...ATTACKER.toBytes()], [{ pubkey: acct }, { pubkey: MEME_MINT, isWritable: false }]),
        ]),
      ),
      /InitializeAccount3 owner must be the wallet/,
    );
    expectDenied(run(v0(wallet, [createAtaIdempotent(wallet, ATTACKER, MEME_MINT)])), /ATA owner must be the wallet/);
  });

  it('denies transfers that do not originate from the wallet', () => {
    const other = Keypair.generate().publicKey;
    const ix = transfer(other, TIP_ACCOUNT, 1n);
    const d = run(v0(wallet, [ix]));
    expectDenied(d, /requires 2 signatures/);
    // Same transfer with the source as a non-signer static key, so only the source rule can deny it.
    const message = new MessageV0({
      header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
      staticAccountKeys: [wallet, other, TIP_ACCOUNT, SYSTEM_PROGRAM_ID],
      recentBlockhash: FAKE_BLOCKHASH,
      compiledInstructions: [{ programIdIndex: 3, accountKeyIndexes: [1, 2], data: new Uint8Array(ix.data) }],
      addressTableLookups: [],
    });
    const only = run(new VersionedTransaction(message));
    expect(only.reasons).toEqual([`instruction 0: transfer source ${other.toBase58()} is not the wallet`]);
  });

  it('denies undecodable input', () => {
    expectDenied(run('AAAA'), /could not be decoded/);
    expectDenied(run('not base64!!'), /could not be decoded/);
  });

  it('denies an ATA create that hands a rogue token program the wallet as rent payer', () => {
    // Regression: the ATA program asks the given token program for the account size and funds that
    // much rent from the payer into an account owned by that program. A rogue program can report
    // 10 MiB and collect about 73 SOL per instruction, none of it visible to the caps.
    const rogueTokenProgram = Keypair.generate().publicKey;
    const ix = createAtaIdempotent(wallet, wallet, MEME_MINT);
    ix.keys[1] = {
      pubkey: associatedTokenAddress(wallet, MEME_MINT, rogueTokenProgram),
      isSigner: false,
      isWritable: true,
    };
    ix.keys[5] = { pubkey: rogueTokenProgram, isSigner: false, isWritable: false };
    const d = run(v0(wallet, [...buyInstructions(wallet), ix]));
    expectDenied(d, /ATA token program .* must be Token or Token-2022/);
    expect(d.reasons).toHaveLength(1);

    const wrongSystem = createAtaIdempotent(wallet, wallet, MEME_MINT);
    wrongSystem.keys[4] = { pubkey: rogueTokenProgram, isSigner: false, isWritable: false };
    expectDenied(run(v0(wallet, [wrongSystem])), /ATA system program account must be the System program/);

    const missing = createAtaIdempotent(wallet, wallet, MEME_MINT);
    missing.keys = missing.keys.slice(0, 5);
    expectDenied(run(v0(wallet, [missing])), /missing ATA token program account/);
  });

  it('denies an ATA create whose token program comes from an address lookup table', () => {
    const rogueTokenProgram = Keypair.generate().publicKey;
    const ix = createAtaIdempotent(wallet, wallet, MEME_MINT);
    ix.keys[5] = { pubkey: rogueTokenProgram, isSigner: false, isWritable: false };
    const tx = v0(wallet, [ix], [lookupTable([rogueTokenProgram])]);
    expect(tx.message.addressTableLookups.length).toBe(1);
    expectDenied(run(tx), /ATA token program account comes from an address lookup table/);
  });

  it('still allows ATA creation through Token-2022', () => {
    const ix = createAtaIdempotent(wallet, wallet, MEME_MINT);
    ix.keys[1] = {
      pubkey: associatedTokenAddress(wallet, MEME_MINT, TOKEN_2022_PROGRAM_ID),
      isSigner: false,
      isWritable: true,
    };
    ix.keys[5] = { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false };
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(run(v0(wallet, [ix])).reasons).toEqual([]);
  });

  it('denies wrapping into the never-valid Token-2022 address for the classic native mint', () => {
    const stranded = associatedTokenAddress(wallet, WRAPPED_SOL_MINT, TOKEN_2022_PROGRAM_ID);
    expectDenied(run(v0(wallet, [transfer(wallet, stranded, 1_000n)])), /unapproved destination/);
  });

  it('denies other compute budget instructions and duplicates', () => {
    const heap = new TransactionInstruction({
      programId: computeBudget(1, 1)[0]!.programId,
      keys: [],
      data: Buffer.from([1, 0, 0, 1, 0]),
    });
    expectDenied(run(v0(wallet, [heap])), /compute budget instruction #1 is not allowed/);
    expectDenied(
      run(v0(wallet, [...computeBudget(1000, 1), ...computeBudget(1000, 1)])),
      /duplicate SetComputeUnitLimit/,
    );
  });
});
