/**
 * Cross-module check: the transactions LiveBroker builds must pass the signer's deny-by-default policy when they
 * carry tickets shaped the way the Risk Officer issues them (risk/pgRiskOfficer.ts):
 *   buy:  maxLamports = reservation - preset tip, maxTipLamports = preset tip
 *   sell: maxLamports = exit fee allowance (10,000,000 by default), maxTipLamports = preset tip
 * The fake router returns a realistic swap-instructions set (compute budget, create the WSOL ATA through the ATA
 * program, system transfer into it, SyncNative, create the output ATA, a Jupiter v6 instruction, close the WSOL
 * ATA to the wallet) with lookup tables that, like Jupiter's shared tables, contain common program and mint keys.
 * The fake signer runs the signer's real policy on the exact bytes it receives. Ephemeral keys only.
 */
import { describe, expect, it } from 'vitest';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { SignedTicket } from '@tidepool/core/ticket';
import {
  decodeTransaction,
  evaluatePolicy,
  type PolicyConfig,
  type PolicyDecision,
} from '../../../signer/src/policy.js';
import { SOL_MINT, type JupiterInstruction, type JupiterQuote, type JupiterSwapInstructions } from './jupiter.js';
import {
  base58Encode,
  JUPITER_V6_PROGRAM,
  LiveBroker,
  priorityFeeLamports,
  type LandingConfig,
  type LiveConnection,
} from './liveBroker.js';
import type { SignerClient } from './signerClient.js';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WSOL = new PublicKey(SOL_MINT);
const JUP = new PublicKey(JUPITER_V6_PROGRAM);

const wallet = Keypair.generate();
const W = wallet.publicKey;
const MINT = Keypair.generate().publicKey; // a Token-2022 meme coin
const TIP_ACCOUNT = Keypair.generate().publicKey;
const AMM = Array.from({ length: 12 }, () => Keypair.generate().publicKey);

/** Balanced preset tip and the Risk Officer's ticket shapes. */
const TIP = 500_000n;
const RESERVATION = 500_000_000n;
const EXIT_FEE_ALLOWANCE = 10_000_000n;

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA)[0];
const WSOL_ATA = ata(W, WSOL, TOKEN);
const OUT_ATA = ata(W, MINT, TOKEN_2022);

function ticket(intent: 'buy' | 'sell', maxLamports: bigint): SignedTicket {
  const now = Date.now();
  return {
    ticket: {
      v: 1,
      reservationId: '00000000-0000-4000-8000-000000000001',
      intent,
      mint: MINT.toBase58(),
      maxLamports: maxLamports.toString(),
      maxTipLamports: TIP.toString(),
      destination: null,
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    mac: 'a'.repeat(64),
  };
}

const toJson = (ix: TransactionInstruction): JupiterInstruction => ({
  programId: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: Buffer.from(ix.data).toString('base64'),
});

function createAtaIdempotent(
  owner: PublicKey,
  mint: PublicKey,
  account: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA,
    keys: [
      { pubkey: W, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

const syncNative = () =>
  new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: WSOL_ATA, isSigner: false, isWritable: true }],
    data: Buffer.from([17]),
  });
const closeWsol = () =>
  new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: WSOL_ATA, isSigner: false, isWritable: true },
      { pubkey: W, isSigner: false, isWritable: true },
      { pubkey: W, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });

function jupiterSwap(): TransactionInstruction {
  return new TransactionInstruction({
    programId: JUP,
    keys: [
      { pubkey: TOKEN, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: W, isSigner: true, isWritable: false },
      { pubkey: WSOL_ATA, isSigner: false, isWritable: true },
      { pubkey: OUT_ATA, isSigner: false, isWritable: true },
      { pubkey: WSOL, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      ...AMM.map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i % 2 === 0 })),
    ],
    data: Buffer.from(Array.from({ length: 40 }, (_, i) => (i * 37) & 0xff)),
  });
}

/** Compute budget the way the router sets it for a requested total priority fee. */
function computeBudget(feeLamports: number, units = 300_000): TransactionInstruction[] {
  const microLamports = Math.ceil((feeLamports * 1_000_000) / units); // rounds up, as a router may
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

function swapInstructions(side: 'buy' | 'sell', amount: bigint, fee: number): JupiterSwapInstructions {
  const setup =
    side === 'buy'
      ? [
          createAtaIdempotent(W, WSOL, WSOL_ATA, TOKEN),
          SystemProgram.transfer({ fromPubkey: W, toPubkey: WSOL_ATA, lamports: amount }),
          syncNative(),
          createAtaIdempotent(W, MINT, OUT_ATA, TOKEN_2022),
        ]
      : [createAtaIdempotent(W, WSOL, WSOL_ATA, TOKEN)];
  return {
    computeBudgetInstructions: computeBudget(fee).map(toJson),
    setupInstructions: setup.map(toJson),
    swapInstruction: toJson(jupiterSwap()),
    cleanupInstruction: toJson(closeWsol()),
    otherInstructions: [],
    addressLookupTableAddresses: [LUT_KEY.toBase58()],
  };
}

/** A shared lookup table holding common programs and mints, the AMM accounts, and the landing tip account. */
const LUT_KEY = Keypair.generate().publicKey;
const LUT = new AddressLookupTableAccount({
  key: LUT_KEY,
  state: {
    deactivationSlot: BigInt('18446744073709551615'),
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority: undefined,
    addresses: [TOKEN, TOKEN_2022, SystemProgram.programId, ATA, WSOL, MINT, TIP_ACCOUNT, ...AMM],
  },
});

function quote(a: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): JupiterQuote {
  const out = 123_456_789_000n;
  return {
    inputMint: a.inputMint,
    outputMint: a.outputMint,
    inAmount: a.amount.toString(),
    outAmount: out.toString(),
    otherAmountThreshold: ((out * BigInt(10_000 - a.slippageBps)) / 10_000n).toString(),
    swapMode: 'ExactIn',
    slippageBps: a.slippageBps,
    priceImpactPct: '0.001',
    routePlan: [
      {
        swapInfo: {
          ammKey: AMM[0]!.toBase58(),
          label: 'Meteora DLMM',
          inputMint: a.inputMint,
          outputMint: a.outputMint,
          inAmount: a.amount.toString(),
          outAmount: out.toString(),
        },
        percent: 100,
      },
    ],
  };
}

const POLICY: PolicyConfig = {
  allowedProgramIds: [],
  tipAccounts: [TIP_ACCOUNT.toBase58()],
  withdrawAllowlist: [],
  maxPerTxLamports: 500_000_000n,
  maxTipLamports: 2_000_000n, // .env.example defaults
};

/** Signer stand-in: the real policy on the exact bytes, then an ephemeral-key signature. */
class PolicySigner implements SignerClient {
  decisions: PolicyDecision[] = [];
  async sign(req: { ticket: SignedTicket; transactionBase64: string }) {
    const tx = decodeTransaction(req.transactionBase64);
    const d = evaluatePolicy({
      transaction: req.transactionBase64,
      wallet: W,
      ticket: req.ticket.ticket,
      config: POLICY,
    });
    this.decisions.push(d);
    if (!d.allow) throw new Error(`policy denied: ${d.reasons.join('; ')}`);
    tx.sign([wallet]);
    return {
      signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'),
      signature: base58Encode(tx.signatures[0]!),
    };
  }
}

function connection(): LiveConnection {
  return {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getAddressLookupTable: async (k) => ({ context: { slot: 1 }, value: k.equals(LUT_KEY) ? LUT : null }),
    sendRawTransaction: async (raw) =>
      base58Encode(VersionedTransaction.deserialize(Uint8Array.from(raw as Uint8Array)).signatures[0]!),
    confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    getTransaction: async () =>
      ({
        slot: 1,
        blockTime: null,
        transaction: { message: { staticAccountKeys: [W] }, signatures: [] },
        meta: {
          err: null,
          fee: 5000,
          preBalances: [10_000_000_000],
          postBalances: [9_500_000_000],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 1,
              mint: MINT.toBase58(),
              owner: W.toBase58(),
              uiTokenAmount: { amount: '123456789000', decimals: 6, uiAmount: null, uiAmountString: '0' },
            },
          ],
          innerInstructions: [],
          logMessages: [],
          loadedAddresses: { writable: [], readonly: [] },
        },
      }) as unknown as VersionedTransactionResponse,
  };
}

function setup(landing: LandingConfig) {
  const signer = new PolicySigner();
  const tipped = landing.method !== 'rpc';
  const broker = new LiveBroker({
    liveTradingEnabled: true,
    connection: connection(),
    signer,
    walletPublicKey: W.toBase58(),
    landing,
    fetch: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { params: [string] };
      const tx = VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64'));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: base58Encode(tx.signatures[0]!) }), {
        status: 200,
      });
    }) as unknown as typeof fetch,
    jupiter: {
      quote: async (a) => quote(a),
      swapInstructions: async (a) => {
        const q = a.quoteResponse;
        const side = q.inputMint === SOL_MINT ? 'buy' : 'sell';
        return swapInstructions(
          side,
          BigInt(q.inAmount),
          typeof a.prioritizationFeeLamports === 'number' ? a.prioritizationFeeLamports : 0,
        );
      },
    },
    sleep: async () => undefined,
    getTransactionRetries: 0,
  });
  /** The swap input the Trader would submit for this reservation (see Trader.tryEnter / reserveAndBuy). */
  const lamportsIn = RESERVATION - (TIP + 5_000n) - broker.extraBuyOverheadLamports();
  return { signer, broker, lamportsIn, tipped };
}

const landings: LandingConfig[] = [
  { method: 'rpc' },
  { method: 'jito', url: 'https://block-engine.test.invalid', tipAccount: TIP_ACCOUNT.toBase58() },
  { method: 'sender', url: 'https://sender.test.invalid/fast', tipAccount: TIP_ACCOUNT.toBase58() },
];

describe('LiveBroker transactions pass the signer policy with Risk Officer tickets', () => {
  for (const landing of landings) {
    it(`buy via ${landing.method}`, async () => {
      const { signer, broker, lamportsIn, tipped } = setup(landing);
      const r = await broker.buy({
        mint: MINT.toBase58(),
        lamportsIn,
        slippageBps: 150,
        tipLamports: TIP,
        ticket: ticket('buy', RESERVATION - TIP),
      });
      expect(signer.decisions[0]?.reasons ?? []).toEqual([]);
      expect(r.ok).toBe(true);
      const d = signer.decisions[0]!;
      expect(d.allow).toBe(true);
      expect(d.spendLamports).toBe(lamportsIn); // only the wrap transfer counts as spend
      expect(d.tipLamports).toBe(tipped ? TIP : 0n);
      expect(d.priorityFeeLamports <= TIP).toBe(true);
      // Everything that can leave the wallet stays inside the reservation, including output-account rent.
      expect(d.spendLamports + d.tipLamports + d.priorityFeeLamports + 5_000n + 2_074_080n <= RESERVATION).toBe(true);
    });

    it(`sell via ${landing.method}`, async () => {
      const { signer, broker, tipped } = setup(landing);
      const r = await broker.sell({
        mint: MINT.toBase58(),
        tokenAmount: 123_456_789_000n,
        slippageBps: 150,
        tipLamports: TIP,
        ticket: ticket('sell', EXIT_FEE_ALLOWANCE),
      });
      expect(signer.decisions[0]?.reasons ?? []).toEqual([]);
      expect(r.ok).toBe(true);
      expect(signer.decisions[0]!).toMatchObject({ allow: true, spendLamports: 0n, tipLamports: tipped ? TIP : 0n });
    });
  }

  it('the router rounding its unit price up would exceed the tip allowance; the broker lowers it to fit', async () => {
    const raw = computeBudget(Number(TIP));
    expect(priorityFeeLamports(raw)).toBe(TIP + 1n); // what the signer would have refused
    const { signer, broker, lamportsIn } = setup({ method: 'rpc' });
    await broker.buy({
      mint: MINT.toBase58(),
      lamportsIn,
      slippageBps: 150,
      tipLamports: TIP,
      ticket: ticket('buy', RESERVATION - TIP),
    });
    expect(signer.decisions[0]!.priorityFeeLamports).toBe(TIP);
  });

  it('without lookup-table masking the same buy is denied (the incompatibility the broker works around)', () => {
    const ixs = swapInstructions('buy', 400_000_000n, 10_000);
    const list = [
      ...ixs.computeBudgetInstructions,
      ...ixs.setupInstructions,
      ixs.swapInstruction,
      ixs.cleanupInstruction!,
    ].map(
      (i) =>
        new TransactionInstruction({
          programId: new PublicKey(i.programId),
          keys: i.accounts.map((a) => ({
            pubkey: new PublicKey(a.pubkey),
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(i.data, 'base64'),
        }),
    );
    list.push(SystemProgram.transfer({ fromPubkey: W, toPubkey: TIP_ACCOUNT, lamports: TIP }));
    const msg = new TransactionMessage({
      payerKey: W,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: list,
    }).compileToV0Message([LUT]);
    const d = evaluatePolicy({
      transaction: Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64'),
      wallet: W,
      ticket: ticket('buy', RESERVATION - TIP).ticket,
      config: POLICY,
    });
    expect(d.allow).toBe(false);
    expect(d.reasons.join('\n')).toMatch(/lookup table/);
  });
});
