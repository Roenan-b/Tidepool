/**
 * Live execution venue: Jupiter swap-instructions -> v0 transaction -> signer (ticket-gated) -> landing
 * (RPC, Helius Sender or Jito) -> confirmation -> actual SOL moved, read from the confirmed transaction's
 * balance changes rather than from quotes.
 *
 * The constructor refuses to build unless liveTradingEnabled is explicitly true. The Sender and Jito request
 * shapes, Jupiter's fields and the tip/priority-fee split must be confirmed against each provider's current
 * documentation before any live use; nothing in this file has been exercised against a real endpoint.
 */
import { createPublicKey, verify as edVerify } from 'node:crypto';
import {
  AddressLookupTableAccount, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type BlockhashWithExpiryBlockHeight, type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment, type Connection, type GetVersionedTransactionConfig, type RpcResponseAndContext, type SendOptions,
  type SignatureResult, type TokenBalance, type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { SignedTicket } from '@tidepool/core/ticket';
import type { Broker } from '../contracts.js';
import { JupiterQuoteSource, quoteProblem, SOL_MINT, type JupiterClient, type JupiterInstruction, type JupiterQuote, type JupiterSwapInstructions } from './jupiter.js';
import type { SignerClient } from './signerClient.js';
import { errorText } from './types.js';

/** The subset of web3.js Connection the LiveBroker uses (a real Connection satisfies it). */
export interface LiveConnection {
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  getAddressLookupTable(accountKey: PublicKey): Promise<RpcResponseAndContext<AddressLookupTableAccount | null>>;
  sendRawTransaction(raw: Buffer | Uint8Array | Array<number>, options?: SendOptions): Promise<string>;
  confirmTransaction(strategy: BlockheightBasedTransactionConfirmationStrategy, commitment?: Commitment): Promise<RpcResponseAndContext<SignatureResult>>;
  getTransaction(signature: string, rawConfig: GetVersionedTransactionConfig): Promise<VersionedTransactionResponse | null>;
}
// Compile-time check that a real Connection fits.
export const _connectionFits: (c: Connection) => LiveConnection = (c) => c;

export type LandingConfig =
  | { method: 'rpc' }
  | { method: 'sender'; url: string; tipAccount: string }
  | { method: 'jito'; url: string; tipAccount: string };

export interface LiveBrokerOptions {
  /** Must be exactly true (LIVE_TRADING_ENABLED=true plus owner confirmation, checked by the caller). */
  liveTradingEnabled: boolean;
  connection: LiveConnection;
  jupiter: Pick<JupiterClient, 'quote' | 'swapInstructions'>;
  signer: SignerClient;
  /** Hot wallet public key (base58). The private key lives only in the signer. */
  walletPublicKey: string;
  landing: LandingConfig;
  /** Priority fee passed to Jupiter when the tip goes to a Sender/Jito tip account instead. */
  priorityFeeLamportsWithTip?: number;
  confirmTimeoutMs?: number;
  httpTimeoutMs?: number;
  /** Upper bound for each RPC call other than confirmation (web3.js applies none by default). */
  rpcTimeoutMs?: number;
  fetch?: typeof fetch;
  getTransactionRetries?: number;
  getTransactionDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Program ids the router's swap instruction may target. Defaults to the Jupiter v6 program. */
  allowedSwapProgramIds?: readonly string[];
  /**
   * Rent a buy may pay to create the output token's associated account (paid inside the ATA program, so it is
   * not visible to the signer's caps but does leave the wallet). 165-byte SPL accounts need 2,039,280 lamports;
   * Token-2022 accounts with the immutable-owner extension need 2,074,080. Defaults to 2,100,000.
   */
  ataRentAllowanceLamports?: bigint;
}

export const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const DEFAULT_ATA_RENT_ALLOWANCE = 2_100_000n;

/**
 * Accounts the signer policy must read from the static key list (it denies when they come from a lookup
 * table): system transfer and create-account endpoints, InitializeAccount owner, CloseAccount destination,
 * and the ATA payer, owner, system program and token program. Program ids are always static already.
 */
export function policyCheckedAccounts(instructions: readonly TransactionInstruction[]): Set<string> {
  const out = new Set<string>();
  const add = (ix: TransactionInstruction, positions: number[]) => {
    for (const p of positions) { const k = ix.keys[p]; if (k) out.add(k.pubkey.toBase58()); }
  };
  for (const ix of instructions) {
    const program = ix.programId.toBase58();
    if (program === SYSTEM_PROGRAM) add(ix, [0, 1]);
    else if (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) {
      const tag = ix.data[0];
      if (tag === 1) add(ix, [2]);
      else if (tag === 9) add(ix, [1]);
    } else if (program === ATA_PROGRAM) add(ix, [0, 2, 4, 5]);
  }
  return out;
}

/**
 * Returns a copy of a lookup table in which the given addresses are replaced by unique placeholders, so the
 * message compiler keeps them as static keys. Indexes of every other address are unchanged, so the compiled
 * message still resolves correctly against the real on-chain table.
 */
export function maskLookupTable(t: AddressLookupTableAccount, keepStatic: ReadonlySet<string>): AddressLookupTableAccount {
  if (!t.state.addresses.some((a) => keepStatic.has(a.toBase58()))) return t;
  const addresses = t.state.addresses.map((a) => (keepStatic.has(a.toBase58()) ? PublicKey.unique() : a));
  return new AddressLookupTableAccount({ key: t.key, state: { ...t.state, addresses } });
}

/**
 * Rewrites SetComputeUnitPrice in place, if present, so the priority fee (as the signer policy computes it) does
 * not exceed `cap`. Leaves the instructions untouched when they already fit.
 */
export function capPriorityFee(instructions: TransactionInstruction[], cap: bigint): void {
  if (priorityFeeLamports(instructions) <= cap) return;
  let limit: bigint | null = null;
  let others = 0n;
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM) others += 1n;
    else if (ix.data[0] === 2 && ix.data.length === 5) limit = BigInt(ix.data.readUInt32LE(1));
  }
  const requested = limit ?? 200_000n * others;
  const units = requested < 1_400_000n ? requested : 1_400_000n;
  if (units === 0n) return;
  const price = (cap * 1_000_000n) / units;
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i]!;
    if (ix.programId.toBase58() === COMPUTE_BUDGET_PROGRAM && ix.data[0] === 3 && ix.data.length === 9) {
      const data = Buffer.alloc(9);
      data[0] = 3;
      data.writeBigUInt64LE(price, 1);
      instructions[i] = new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
    }
  }
}

/** Priority fee the compute budget instructions commit to, computed the way the signer policy does. */
export function priorityFeeLamports(instructions: readonly TransactionInstruction[]): bigint {
  let limit: bigint | null = null;
  let price = 0n;
  let others = 0n;
  for (const ix of instructions) {
    if (ix.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM) { others += 1n; continue; }
    if (ix.data[0] === 2 && ix.data.length === 5) limit = BigInt(ix.data.readUInt32LE(1));
    else if (ix.data[0] === 3 && ix.data.length === 9) price = ix.data.readBigUInt64LE(1);
  }
  const requested = limit ?? 200_000n * others;
  const units = requested < 1_400_000n ? requested : 1_400_000n;
  return (price * units + 999_999n) / 1_000_000n;
}

/** Thrown when a transaction may or may not have landed. Callers must not release funds on this error. */
export class UnknownOutcomeError extends Error {
  constructor(message: string, readonly signature: string | null) {
    super(message);
    this.name = 'UnknownOutcomeError';
  }
}

type BuyResult = Awaited<ReturnType<Broker['buy']>>;
type SellResult = Awaited<ReturnType<Broker['sell']>>;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = `1${out}`; }
  return out;
}

function toInstruction(i: JupiterInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, 'base64'),
  });
}

function checkUrl(raw: string, name: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`${name} is not a valid URL`); }
  if (u.protocol !== 'https:') throw new Error(`${name} must use https`);
  return raw;
}

type Sent = { kind: 'sent'; signature: string } | { kind: 'rejected'; error: string } | { kind: 'ambiguous'; error: string };

export class LiveBroker implements Broker {
  readonly mode = 'live' as const;
  private readonly wallet: PublicKey;
  private readonly tipAccount: PublicKey | null;
  private readonly quotes: JupiterQuoteSource;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly swapPrograms: Set<string>;
  private readonly ataRentAllowance: bigint;

  constructor(private readonly opts: LiveBrokerOptions) {
    if (opts.liveTradingEnabled !== true) throw new Error('LiveBroker refused: live trading is not enabled');
    this.wallet = new PublicKey(opts.walletPublicKey);
    if (opts.landing.method === 'rpc') {
      this.tipAccount = null;
    } else {
      checkUrl(opts.landing.url, `${opts.landing.method} URL`);
      this.tipAccount = new PublicKey(opts.landing.tipAccount);
    }
    this.quotes = new JupiterQuoteSource(opts.jupiter);
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.swapPrograms = new Set((opts.allowedSwapProgramIds ?? [JUPITER_V6_PROGRAM]).map((k) => new PublicKey(k).toBase58()));
    const rent = opts.ataRentAllowanceLamports ?? DEFAULT_ATA_RENT_ALLOWANCE;
    if (rent < 0n) throw new RangeError('ataRentAllowanceLamports must be non-negative');
    this.ataRentAllowance = rent;
  }

  /**
   * SOL a buy can move out of the wallet beyond the swap input, the tip and the base fee: the priority fee when
   * the tip goes to a Sender/Jito account, plus rent for the output token account. The Trader subtracts this
   * from the reservation so actual spend stays inside it.
   */
  extraBuyOverheadLamports(): bigint {
    const tipped = this.opts.landing.method !== 'rpc';
    return (tipped ? BigInt(this.opts.priorityFeeLamportsWithTip ?? 10_000) : 0n) + this.ataRentAllowance;
  }

  quote(mint: string, side: 'buy' | 'sell', amount: bigint) {
    return this.quotes.quote(mint, side, amount);
  }

  async buy(args: { mint: string; lamportsIn: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<BuyResult> {
    if (!args.ticket) return { ok: false, error: 'live buy without ticket', burnedFeeLamports: 0n };
    const r = await this.swap({ inputMint: SOL_MINT, outputMint: args.mint, amount: args.lamportsIn, slippageBps: args.slippageBps, tipLamports: args.tipLamports, ticket: args.ticket });
    if (!r.ok) return r;
    const tokenAmount = r.tokenDelta > 0n ? r.tokenDelta : 0n;
    return { ok: true, lamportsSpent: -r.solDelta, tokenAmount, signature: r.signature };
  }

  async sell(args: { mint: string; tokenAmount: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket | null }): Promise<SellResult> {
    if (!args.ticket) return { ok: false, error: 'live sell without ticket', burnedFeeLamports: 0n };
    const r = await this.swap({ inputMint: args.mint, outputMint: SOL_MINT, amount: args.tokenAmount, slippageBps: args.slippageBps, tipLamports: args.tipLamports, ticket: args.ticket });
    if (!r.ok) return r;
    return { ok: true, lamportsReceived: r.solDelta, signature: r.signature };
  }

  private async swap(a: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number; tipLamports: bigint; ticket: SignedTicket }):
    Promise<{ ok: true; solDelta: bigint; tokenDelta: bigint; signature: string } | { ok: false; error: string; burnedFeeLamports: bigint }> {
    const tokenMint = a.inputMint === SOL_MINT ? a.outputMint : a.inputMint;
    // 1. Build. Any failure before sending costs nothing.
    let tx: VersionedTransaction;
    let blockhash: BlockhashWithExpiryBlockHeight;
    try {
      const request = { inputMint: a.inputMint, outputMint: a.outputMint, amount: a.amount, slippageBps: a.slippageBps };
      const quote: JupiterQuote = await this.opts.jupiter.quote(request);
      // Re-checked here because the quote is sent back verbatim and its threshold becomes the swap's minimum out.
      const problem = quoteProblem(quote, request);
      if (problem) throw new Error(`quote does not match the request: ${problem}`);
      const tipped = this.opts.landing.method !== 'rpc';
      const ixs = await this.opts.jupiter.swapInstructions({
        quoteResponse: quote,
        userPublicKey: this.wallet.toBase58(),
        prioritizationFeeLamports: tipped ? (this.opts.priorityFeeLamportsWithTip ?? 10_000) : Number(a.tipLamports),
      });
      if (!this.swapPrograms.has(ixs.swapInstruction.programId)) throw new Error(`swap instruction targets unexpected program ${ixs.swapInstruction.programId}`);
      ({ tx, blockhash } = await this.buildTransaction(ixs, tipped ? a.tipLamports : 0n, a.ticket));
    } catch (err) {
      return { ok: false, error: `build failed: ${errorText(err, 300)}`, burnedFeeLamports: 0n };
    }

    // 2. Sign. The signer checks the ticket and its policy; we check it signed exactly our message.
    let signed: VersionedTransaction;
    let signature: string;
    try {
      const res = await this.opts.signer.sign({ ticket: a.ticket, transactionBase64: Buffer.from(tx.serialize()).toString('base64') });
      signed = VersionedTransaction.deserialize(Buffer.from(res.signedTransactionBase64, 'base64'));
      this.verifySigned(tx, signed, res.signature);
      signature = res.signature;
    } catch (err) {
      return { ok: false, error: `signing failed: ${errorText(err, 300)}`, burnedFeeLamports: 0n };
    }

    // 3. Send.
    const raw = signed.serialize();
    const sent = await this.send(raw, signature);
    if (sent.kind === 'rejected') return { ok: false, error: `send rejected: ${sent.error}`, burnedFeeLamports: 0n };

    // 4. Confirm (an ambiguous send still gets confirmed by blockhash expiry).
    const status = await this.confirm(signature, blockhash);
    if (status === 'expired') return { ok: false, error: sent.kind === 'ambiguous' ? `not landed (send error: ${sent.error})` : 'not landed before blockhash expiry', burnedFeeLamports: 0n };

    // 5. Read the actual balance changes.
    const meta = await this.fetchMeta(signature);
    if (meta.err !== null) {
      const burned = -meta.solDelta;
      return { ok: false, error: `transaction failed on chain: ${JSON.stringify(meta.err).slice(0, 200)}`, burnedFeeLamports: burned > 0n ? burned : 0n };
    }
    return { ok: true, solDelta: meta.solDelta, tokenDelta: this.tokenDelta(meta.tx, tokenMint), signature };
  }

  private async buildTransaction(ixs: JupiterSwapInstructions, tipLamports: bigint, ticket: SignedTicket): Promise<{ tx: VersionedTransaction; blockhash: BlockhashWithExpiryBlockHeight }> {
    const list: JupiterInstruction[] = [
      ...ixs.computeBudgetInstructions,
      ...ixs.setupInstructions,
      ...(ixs.tokenLedgerInstruction ? [ixs.tokenLedgerInstruction] : []),
      ixs.swapInstruction,
      ...(ixs.cleanupInstruction ? [ixs.cleanupInstruction] : []),
      ...(ixs.otherInstructions ?? []),
    ];
    // Fail closed if the router asks for any signer other than our wallet.
    for (const i of list) {
      for (const acc of i.accounts) {
        if (acc.isSigner && acc.pubkey !== this.wallet.toBase58()) throw new Error('route requires an unexpected signer');
      }
    }
    const instructions = list.map(toInstruction);
    if (tipLamports > 0n && this.tipAccount) {
      instructions.push(SystemProgram.transfer({ fromPubkey: this.wallet, toPubkey: this.tipAccount, lamports: tipLamports }));
    }
    // Checks the signer would make, done here so a doomed transaction does not consume the single-use ticket.
    const tipCap = /^\d{1,20}$/.test(ticket.ticket.maxTipLamports) ? BigInt(ticket.ticket.maxTipLamports) : 0n;
    if (tipLamports > tipCap) throw new Error(`tip ${tipLamports} exceeds ticket tip allowance ${tipCap}`);
    // The router derives the compute unit price from the requested fee; its rounding can land a lamport above the
    // allowance, which the signer would refuse. Lower the price to fit instead of losing the trade.
    capPriorityFee(instructions, tipCap);
    const prio = priorityFeeLamports(instructions);
    if (prio > tipCap) throw new Error(`priority fee ${prio} exceeds ticket tip allowance ${tipCap}`);
    // Keep every account the signer policy must verify out of lookup tables (it denies table-resolved ones).
    const keepStatic = policyCheckedAccounts(instructions);
    const alts = await Promise.all(ixs.addressLookupTableAddresses.map(async (addr) => {
      const r = await this.rpc(this.opts.connection.getAddressLookupTable(new PublicKey(addr)), 'getAddressLookupTable');
      if (!r.value) throw new Error(`lookup table ${addr} not found`);
      return maskLookupTable(r.value, keepStatic);
    }));
    const blockhash = await this.rpc(this.opts.connection.getLatestBlockhash('confirmed'), 'getLatestBlockhash');
    const message = new TransactionMessage({ payerKey: this.wallet, recentBlockhash: blockhash.blockhash, instructions }).compileToV0Message(alts);
    return { tx: new VersionedTransaction(message), blockhash };
  }

  /** Bounds an RPC call so a hung endpoint cannot stall an entry or an exit forever. A timeout is an error. */
  private rpc<T>(p: Promise<T>, what: string): Promise<T> {
    const ms = this.opts.rpcTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${what} timed out after ${ms} ms`), { name: 'RpcTimeoutError' })), ms); });
    p.catch(() => undefined);
    return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  private verifySigned(unsigned: VersionedTransaction, signed: VersionedTransaction, signature: string): void {
    const ours = Buffer.from(unsigned.message.serialize());
    const theirs = Buffer.from(signed.message.serialize());
    if (!ours.equals(theirs)) throw new Error('signer returned a different message');
    const sig = signed.signatures[0];
    if (!sig || sig.length !== 64) throw new Error('signed transaction has no fee-payer signature');
    if (base58Encode(sig) !== signature) throw new Error('signature does not match signed transaction');
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(this.wallet.toBytes()).toString('base64url') }, format: 'jwk' });
    if (!edVerify(null, theirs, key, Buffer.from(sig))) throw new Error('fee-payer signature does not verify');
  }

  private async send(raw: Uint8Array, signature: string): Promise<Sent> {
    const landing = this.opts.landing;
    if (landing.method === 'rpc') {
      try {
        const sig = await this.rpc(this.opts.connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 2 }), 'sendRawTransaction');
        if (sig !== signature) return { kind: 'ambiguous', error: 'rpc returned a different signature' };
        return { kind: 'sent', signature };
      } catch (err) {
        // A preflight rejection means the transaction was never forwarded.
        const name = err instanceof Error ? err.name : '';
        if (name === 'SendTransactionError') return { kind: 'rejected', error: errorText(err, 300) };
        return { kind: 'ambiguous', error: errorText(err, 300) };
      }
    }
    // Sender and Jito both accept a JSON-RPC sendTransaction call (confirm request shape and path before use).
    const url = landing.method === 'jito' ? `${landing.url.replace(/\/+$/, '')}/api/v1/transactions` : landing.url;
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [Buffer.from(raw).toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
        signal: AbortSignal.timeout(this.opts.httpTimeoutMs ?? 5_000),
        redirect: 'error',
      });
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: unknown } } | null;
      if (body && body.error) return { kind: 'rejected', error: String(body.error.message ?? 'rejected').slice(0, 200) };
      if (!res.ok) return { kind: res.status >= 500 ? 'ambiguous' : 'rejected', error: `HTTP ${res.status}` };
      if (typeof body?.result !== 'string' || body.result !== signature) return { kind: 'ambiguous', error: 'unexpected send result' };
      return { kind: 'sent', signature };
    } catch (err) {
      return { kind: 'ambiguous', error: errorText(err, 200) };
    }
  }

  /** 'landed' when confirmed (successful or failed), 'expired' when the blockhash expired unseen. Throws UnknownOutcomeError on timeout. */
  private async confirm(signature: string, bh: BlockhashWithExpiryBlockHeight): Promise<'landed' | 'expired'> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 90_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
    const confirmation = this.opts.connection.confirmTransaction({ signature, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed')
      .then(() => 'landed' as const)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === 'TransactionExpiredBlockheightExceededError') return 'expired' as const;
        throw new UnknownOutcomeError(`confirmation error: ${errorText(err, 200)}`, signature);
      });
    // If the timeout wins the race, a later rejection must not surface as an unhandled rejection (which
    // terminates a Node process by default).
    confirmation.catch(() => undefined);
    try {
      const result = await Promise.race([confirmation, timeout]);
      if (result === 'timeout') throw new UnknownOutcomeError(`not confirmed within ${timeoutMs} ms`, signature);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async fetchMeta(signature: string): Promise<{ tx: VersionedTransactionResponse; err: unknown; solDelta: bigint }> {
    const retries = this.opts.getTransactionRetries ?? 5;
    for (let i = 0; i <= retries; i++) {
      let tx: VersionedTransactionResponse | null = null;
      try {
        tx = await this.rpc(this.opts.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }), 'getTransaction');
      } catch { /* retry */ }
      if (tx?.meta) {
        const payer = tx.transaction.message.staticAccountKeys[0];
        if (!payer || !payer.equals(this.wallet)) throw new UnknownOutcomeError('confirmed transaction fee payer is not the wallet', signature);
        const pre = tx.meta.preBalances[0];
        const post = tx.meta.postBalances[0];
        if (pre === undefined || post === undefined) throw new UnknownOutcomeError('transaction meta has no balances', signature);
        return { tx, err: tx.meta.err ?? null, solDelta: BigInt(post) - BigInt(pre) };
      }
      if (i < retries) await this.sleep(this.opts.getTransactionDelayMs ?? 500);
    }
    throw new UnknownOutcomeError('confirmed but transaction meta unavailable', signature);
  }

  private tokenDelta(tx: VersionedTransactionResponse, mint: string): bigint {
    const owner = this.wallet.toBase58();
    const sum = (list: TokenBalance[] | null | undefined) => {
      let total = 0n;
      for (const b of list ?? []) {
        if (b.mint === mint && b.owner === owner && /^\d+$/.test(b.uiTokenAmount.amount)) total += BigInt(b.uiTokenAmount.amount);
      }
      return total;
    };
    return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
  }
}
