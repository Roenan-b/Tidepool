/**
 * LiveBroker tests use a fake Connection, a fake Jupiter client and a fake signer backed by an ephemeral
 * Keypair generated in the test. Nothing here sends a transaction or touches a network endpoint.
 */
import { describe, expect, it } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { SOL_MINT, type JupiterQuote, type JupiterSwapInstructions } from './jupiter.js';
import {
  base58Encode,
  JUPITER_V6_PROGRAM,
  LiveBroker,
  UnknownOutcomeError,
  type LandingConfig,
  type LiveConnection,
} from './liveBroker.js';
import type { SignerClient } from './signerClient.js';
import { makeTicket, MINT_A } from './testkit.js';

const wallet = Keypair.generate();
const WALLET = wallet.publicKey.toBase58();
const PROGRAM = Keypair.generate().publicKey.toBase58();
const TIP_ACCOUNT = Keypair.generate().publicKey.toBase58();
const ticket = makeTicket('buy', MINT_A, 1_000_000_000n, Date.now() + 60_000);

function quote(inputMint: string, outputMint: string, amount: bigint, slippageBps = 100): JupiterQuote {
  const threshold = (999_999n * BigInt(10_000 - slippageBps)) / 10_000n;
  return {
    inputMint,
    outputMint,
    inAmount: amount.toString(),
    outAmount: '999999',
    otherAmountThreshold: threshold.toString(),
    swapMode: 'ExactIn',
    slippageBps,
    priceImpactPct: '0.001',
    routePlan: [
      {
        swapInfo: {
          ammKey: PROGRAM,
          label: 'Raydium',
          inputMint,
          outputMint,
          inAmount: amount.toString(),
          outAmount: '999999',
        },
        percent: 100,
      },
    ],
  };
}

function fakeJupiter(signers: string[] = [WALLET]) {
  const calls: { quote: unknown[]; swap: { prioritizationFeeLamports: unknown }[] } = { quote: [], swap: [] };
  const ixs: JupiterSwapInstructions = {
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: {
      programId: JUPITER_V6_PROGRAM,
      accounts: signers.map((s) => ({ pubkey: s, isSigner: true, isWritable: true })),
      data: 'AQID',
    },
    cleanupInstruction: null,
    addressLookupTableAddresses: [],
  };
  return {
    calls,
    client: {
      quote: async (a: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }) => {
        calls.quote.push(a);
        return quote(a.inputMint, a.outputMint, a.amount, a.slippageBps);
      },
      swapInstructions: async (a: { prioritizationFeeLamports: unknown }) => {
        calls.swap.push(a);
        return ixs;
      },
    },
  };
}

class FakeSigner implements SignerClient {
  calls: { ticket: unknown; transactionBase64: string }[] = [];
  tamper: 'message' | 'signature' | null = null;
  async sign(req: { ticket: unknown; transactionBase64: string }) {
    this.calls.push(req);
    const tx = VersionedTransaction.deserialize(Buffer.from(req.transactionBase64, 'base64'));
    if (this.tamper === 'message') tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign([wallet]);
    const sig =
      this.tamper === 'signature' ? base58Encode(new Uint8Array(64).fill(7)) : base58Encode(tx.signatures[0]!);
    return { signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'), signature: sig };
  }
}

interface ConnOpts {
  pre?: number;
  post?: number;
  err?: unknown;
  tokenPre?: string | null;
  tokenPost?: string;
  confirm?: 'ok' | 'hang' | 'expired';
  sendError?: string;
  payer?: string;
  mint?: string;
}
function fakeConnection(o: ConnOpts = {}) {
  const sent: Uint8Array[] = [];
  const sendOpts: unknown[] = [];
  const conn: LiveConnection = {
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getAddressLookupTable: async () => ({ context: { slot: 1 }, value: null }),
    sendRawTransaction: async (raw, opts) => {
      if (o.sendError) throw Object.assign(new Error('preflight failed'), { name: o.sendError });
      const bytes = Uint8Array.from(raw as Uint8Array);
      sent.push(bytes);
      sendOpts.push(opts);
      return base58Encode(VersionedTransaction.deserialize(bytes).signatures[0]!);
    },
    confirmTransaction: async () => {
      if (o.confirm === 'hang') return new Promise(() => undefined);
      if (o.confirm === 'expired')
        throw Object.assign(new Error('expired'), { name: 'TransactionExpiredBlockheightExceededError' });
      return { context: { slot: 1 }, value: { err: null } };
    },
    getTransaction: async () => {
      const mint = o.mint ?? MINT_A;
      const bal = (amount: string) => ({
        accountIndex: 1,
        mint,
        owner: WALLET,
        uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: '0' },
      });
      return {
        slot: 1,
        blockTime: null,
        transaction: { message: { staticAccountKeys: [new PublicKey(o.payer ?? WALLET)] }, signatures: [] },
        meta: {
          err: o.err ?? null,
          fee: 5000,
          preBalances: [o.pre ?? 10_000_000_000, 0],
          postBalances: [o.post ?? 9_499_000_000, 0],
          preTokenBalances: o.tokenPre === null ? [] : [bal(o.tokenPre ?? '0')],
          postTokenBalances: [bal(o.tokenPost ?? '12345')],
          innerInstructions: [],
          logMessages: [],
          loadedAddresses: { writable: [], readonly: [] },
        },
      } as unknown as VersionedTransactionResponse;
    },
  };
  return { conn, sent, sendOpts };
}

function broker(
  over: {
    conn?: LiveConnection;
    signer?: FakeSigner;
    jup?: ReturnType<typeof fakeJupiter>;
    landing?: LandingConfig;
    fetch?: typeof fetch;
    confirmTimeoutMs?: number;
    rpcTimeoutMs?: number;
  } = {},
) {
  const jup = over.jup ?? fakeJupiter();
  const signer = over.signer ?? new FakeSigner();
  const conn = over.conn ?? fakeConnection().conn;
  const fetchFn =
    over.fetch ??
    (async () => {
      throw new Error('network must not be used');
    });
  const b = new LiveBroker({
    liveTradingEnabled: true,
    connection: conn,
    jupiter: jup.client,
    signer,
    walletPublicKey: WALLET,
    landing: over.landing ?? { method: 'rpc' },
    fetch: fetchFn,
    confirmTimeoutMs: over.confirmTimeoutMs ?? 1_000,
    sleep: async () => undefined,
    getTransactionRetries: 1,
    ...(over.rpcTimeoutMs !== undefined ? { rpcTimeoutMs: over.rpcTimeoutMs } : {}),
  });
  return { b, jup, signer };
}

describe('LiveBroker', () => {
  it('refuses construction unless live trading is explicitly enabled', () => {
    const base = {
      connection: fakeConnection().conn,
      jupiter: fakeJupiter().client,
      signer: new FakeSigner(),
      walletPublicKey: WALLET,
      landing: { method: 'rpc' } as const,
    };
    expect(() => new LiveBroker({ ...base, liveTradingEnabled: false })).toThrow(/not enabled/);
    expect(() => new LiveBroker({ ...base, liveTradingEnabled: 'true' as unknown as boolean })).toThrow(/not enabled/);
    expect(() => new LiveBroker({ ...base, liveTradingEnabled: true }).mode).not.toThrow();
  });

  it('buys through the signer and books actual SOL spent from transaction meta, not the quote', async () => {
    const c = fakeConnection({ pre: 10_000_000_000, post: 9_499_000_000, tokenPre: null, tokenPost: '12345' });
    const { b, signer, jup } = broker({ conn: c.conn });
    const r = await b.buy({
      mint: MINT_A,
      lamportsIn: 1_000_000_000n,
      slippageBps: 150,
      tipLamports: 500_000n,
      ticket,
    });
    expect(r).toMatchObject({ ok: true, lamportsSpent: 501_000_000n, tokenAmount: 12_345n });
    expect(signer.calls).toHaveLength(1);
    expect(signer.calls[0]!.ticket).toBe(ticket);
    expect(jup.calls.swap[0]!.prioritizationFeeLamports).toBe(500_000); // rpc landing: tip is the priority fee
    expect(c.sent).toHaveLength(1);
    expect(c.sendOpts[0]).toMatchObject({ skipPreflight: false });
    const tx = VersionedTransaction.deserialize(c.sent[0]!);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(WALLET);
  });

  it('sells and books actual SOL received', async () => {
    const c = fakeConnection({ pre: 9_000_000_000, post: 9_480_000_000, tokenPre: '12345', tokenPost: '0' });
    const { b } = broker({ conn: c.conn });
    const r = await b.sell({
      mint: MINT_A,
      tokenAmount: 12_345n,
      slippageBps: 150,
      tipLamports: 500_000n,
      ticket: makeTicket('sell', MINT_A, 0n, Date.now() + 60_000),
    });
    expect(r).toEqual({ ok: true, lamportsReceived: 480_000_000n, signature: expect.any(String) });
  });

  it('a landed-but-failed transaction reports the burned fee from meta', async () => {
    const c = fakeConnection({
      pre: 10_000_000_000,
      post: 9_999_495_000,
      err: { InstructionError: [0, { Custom: 6001 }] },
    });
    const { b } = broker({ conn: c.conn });
    const r = await b.buy({
      mint: MINT_A,
      lamportsIn: 1_000_000_000n,
      slippageBps: 150,
      tipLamports: 500_000n,
      ticket,
    });
    expect(r).toMatchObject({ ok: false, burnedFeeLamports: 505_000n });
  });

  it('refuses without a ticket and never calls the signer', async () => {
    const { b, signer } = broker();
    expect(
      await b.buy({ mint: MINT_A, lamportsIn: 1n, slippageBps: 150, tipLamports: 0n, ticket: null }),
    ).toMatchObject({ ok: false, burnedFeeLamports: 0n });
    expect(signer.calls).toHaveLength(0);
  });

  it('rejects a signer response with an altered message or wrong signature, and sends nothing', async () => {
    for (const tamper of ['message', 'signature'] as const) {
      const c = fakeConnection();
      const signer = new FakeSigner();
      signer.tamper = tamper;
      const { b } = broker({ conn: c.conn, signer });
      const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
      expect(r).toMatchObject({ ok: false, burnedFeeLamports: 0n });
      expect(!r.ok && r.error).toMatch(/signing failed/);
      expect(c.sent).toHaveLength(0);
    }
  });

  it('fails closed when the route asks for an unexpected signer', async () => {
    const jup = fakeJupiter([WALLET, Keypair.generate().publicKey.toBase58()]);
    const { b, signer } = broker({ jup });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
    expect(!r.ok && r.error).toMatch(/unexpected signer/);
    expect(signer.calls).toHaveLength(0);
  });

  it('jito landing adds a tip transfer and submits via the configured endpoint (fake fetch)', async () => {
    const posted: { url: string; body: { method: string; params: [string, unknown] } }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posted.push({ url, body });
      const tx = VersionedTransaction.deserialize(Buffer.from(body.params[0], 'base64'));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: base58Encode(tx.signatures[0]!) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const c = fakeConnection();
    const { b, jup } = broker({
      conn: c.conn,
      fetch: fetchFn,
      landing: { method: 'jito', url: 'https://block-engine.test.invalid', tipAccount: TIP_ACCOUNT },
    });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 1_000_000n, ticket });
    expect(r.ok).toBe(true);
    expect(c.sent).toHaveLength(0); // not sent through RPC
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://block-engine.test.invalid/api/v1/transactions');
    expect(posted[0]!.body.method).toBe('sendTransaction');
    expect(jup.calls.swap[0]!.prioritizationFeeLamports).toBe(10_000);
    const tx = VersionedTransaction.deserialize(Buffer.from(posted[0]!.body.params[0], 'base64'));
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys).toContain(TIP_ACCOUNT);
    expect(keys).toContain(SystemProgram.programId.toBase58());
  });

  it('a preflight rejection is a costless failure; an expired blockhash is a costless failure', async () => {
    const rej = broker({ conn: fakeConnection({ sendError: 'SendTransactionError' }).conn });
    expect(
      await rej.b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket }),
    ).toMatchObject({ ok: false, burnedFeeLamports: 0n });
    const exp = broker({ conn: fakeConnection({ confirm: 'expired' }).conn });
    const r = await exp.b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
    expect(r).toMatchObject({ ok: false, burnedFeeLamports: 0n });
    expect(!r.ok && r.error).toMatch(/not landed/);
  });

  it('a confirmation timeout is an unknown outcome, never a silent failure', async () => {
    const { b } = broker({ conn: fakeConnection({ confirm: 'hang' }).conn, confirmTimeoutMs: 20 });
    await expect(
      b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket }),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it('refuses meta whose fee payer is not the wallet', async () => {
    const { b } = broker({ conn: fakeConnection({ payer: Keypair.generate().publicKey.toBase58() }).conn });
    await expect(
      b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket }),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it('quotes through Jupiter with SOL as the buy input', async () => {
    const { b, jup } = broker();
    const q = await b.quote(MINT_A, 'buy', 1_000_000n);
    expect(q.routeOk).toBe(true);
    expect(jup.calls.quote[0]).toMatchObject({ inputMint: SOL_MINT, outputMint: MINT_A, amount: 1_000_000n });
  });

  it('base58Encode matches web3.js', () => {
    const k = Keypair.generate().publicKey;
    expect(base58Encode(k.toBytes())).toBe(k.toBase58());
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});

describe('LiveBroker review regressions', () => {
  it('refuses a quote whose minimum-out was weakened, or that routes elsewhere, before using the ticket', async () => {
    for (const bad of [
      { otherAmountThreshold: '0' },
      { slippageBps: 5_000 },
      { swapMode: 'ExactOut' },
      { outputMint: Keypair.generate().publicKey.toBase58() },
    ]) {
      const jup = fakeJupiter();
      const base = jup.client.quote;
      jup.client.quote = async (a) => ({ ...(await base(a)), ...bad }) as JupiterQuote;
      const { b, signer } = broker({ jup });
      const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
      expect(!r.ok && r.error).toMatch(/quote does not match/);
      expect(signer.calls).toHaveLength(0);
    }
  });

  it('refuses a swap instruction for a program other than the configured router', async () => {
    const jup = fakeJupiter();
    const base = jup.client.swapInstructions;
    jup.client.swapInstructions = async (a) => ({
      ...(await base(a)),
      swapInstruction: { programId: PROGRAM, accounts: [], data: 'AQID' },
    });
    const { b, signer } = broker({ jup });
    const r = await b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
    expect(!r.ok && r.error).toMatch(/unexpected program/);
    expect(signer.calls).toHaveLength(0);
  });

  it('a confirmation error after the timeout does not become an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => {
      unhandled.push(e);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = fakeConnection();
      c.conn.confirmTransaction = () =>
        new Promise((_r, rej) => setTimeout(() => rej(new Error('websocket closed')), 30));
      const { b } = broker({ conn: c.conn, confirmTimeoutMs: 5 });
      await expect(
        b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket }),
      ).rejects.toBeInstanceOf(UnknownOutcomeError);
      await new Promise((r) => setTimeout(r, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a hung RPC call times out: before signing it fails cleanly, after signing it is an unknown outcome', async () => {
    const c1 = fakeConnection();
    c1.conn.getLatestBlockhash = () => new Promise(() => undefined);
    const a = broker({ conn: c1.conn, rpcTimeoutMs: 10 });
    const r = await a.b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket });
    expect(!r.ok && r.error).toMatch(/getLatestBlockhash timed out/);
    expect(a.signer.calls).toHaveLength(0);

    const c2 = fakeConnection({ confirm: 'hang' });
    c2.conn.sendRawTransaction = () => new Promise(() => undefined);
    const b2 = broker({ conn: c2.conn, rpcTimeoutMs: 10, confirmTimeoutMs: 20 });
    await expect(
      b2.b.buy({ mint: MINT_A, lamportsIn: 1_000_000n, slippageBps: 150, tipLamports: 0n, ticket }),
    ).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it('reports the extra buy overhead the Trader must reserve (rent, plus priority fee when tipping separately)', () => {
    expect(broker().b.extraBuyOverheadLamports()).toBe(2_100_000n);
    const jito = broker({
      landing: { method: 'jito', url: 'https://block-engine.test.invalid', tipAccount: TIP_ACCOUNT },
    });
    expect(jito.b.extraBuyOverheadLamports()).toBe(2_110_000n);
  });
});
