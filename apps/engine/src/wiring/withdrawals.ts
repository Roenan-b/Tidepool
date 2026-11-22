/**
 * Live withdrawal execution. The Risk Officer authorizes a withdrawal by placing a hold and issuing a
 * withdraw ticket bound to the allowlisted destination. This executor builds the plain SOL transfer,
 * has the signer sign it (the signer re-checks the ticket, the destination allowlist and its caps),
 * submits it, waits for confirmation and only then books it with `recordWithdrawal`.
 *
 * Failure handling is deliberately conservative. Nothing is booked unless the transfer is confirmed.
 * If the outcome is unknown (timeout after submission), the hold is left to expire and the next
 * reconciliation compares the books with the chain, so a transfer that landed late halts trading
 * instead of being silently lost.
 */
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { SignedTicket } from '@tidepool/core/ticket';
import type { SignerClient } from '../trader/signerClient.js';

export interface WithdrawalJob {
  withdrawalId: string;
  lamports: bigint;
  destination: string;
  ticket: SignedTicket;
}

export interface WithdrawalChain {
  latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRaw(raw: Uint8Array): Promise<string>;
  /** Resolves true when confirmed, false when the blockhash expired without the transaction landing. */
  confirm(signature: string, blockhash: string, lastValidBlockHeight: number): Promise<boolean>;
  /** Fee actually charged, when the RPC can report it. */
  feeLamports?(signature: string): Promise<bigint | null>;
}

export type WithdrawalOutcome =
  | { status: 'booked'; signature: string; feeLamports: bigint }
  | { status: 'not_landed'; signature: string }
  | { status: 'unknown'; signature: string | null; error: string }
  | { status: 'refused'; error: string };

export interface WithdrawalExecutorDeps {
  wallet: PublicKey;
  signer: SignerClient;
  chain: WithdrawalChain;
  record(withdrawalId: string, lamportsSent: bigint, feeLamports: bigint, signature: string): Promise<void>;
  /** Base fee for one signature, used when the RPC cannot report the charged fee. */
  baseFeeLamports?: bigint;
  onOutcome?(job: WithdrawalJob, outcome: WithdrawalOutcome): void;
}

const DEFAULT_BASE_FEE = 5_000n;

export class WithdrawalExecutor {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: WithdrawalExecutorDeps) {}

  /** Builds the unsigned transfer. Exposed for tests. */
  static buildTransfer(wallet: PublicKey, job: Pick<WithdrawalJob, 'lamports' | 'destination'>, blockhash: string): VersionedTransaction {
    if (job.lamports <= 0n) throw new Error('withdrawal amount must be positive');
    const to = new PublicKey(job.destination);
    const message = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: job.lamports })],
    }).compileToV0Message();
    return new VersionedTransaction(message);
  }

  async execute(job: WithdrawalJob): Promise<WithdrawalOutcome> {
    if (this.inFlight.has(job.withdrawalId)) return { status: 'refused', error: 'withdrawal already in flight' };
    this.inFlight.add(job.withdrawalId);
    try {
      const outcome = await this.run(job);
      this.deps.onOutcome?.(job, outcome);
      return outcome;
    } finally {
      this.inFlight.delete(job.withdrawalId);
    }
  }

  private async run(job: WithdrawalJob): Promise<WithdrawalOutcome> {
    let blockhash: { blockhash: string; lastValidBlockHeight: number };
    let signed: { signedTransactionBase64: string; signature: string };
    try {
      blockhash = await this.deps.chain.latestBlockhash();
      const tx = WithdrawalExecutor.buildTransfer(this.deps.wallet, job, blockhash.blockhash);
      signed = await this.deps.signer.sign({ ticket: job.ticket, transactionBase64: Buffer.from(tx.serialize()).toString('base64') });
    } catch (err) {
      // Nothing was submitted; the hold expires on its own.
      return { status: 'refused', error: message(err) };
    }

    let signature: string;
    try {
      signature = await this.deps.chain.sendRaw(Buffer.from(signed.signedTransactionBase64, 'base64'));
    } catch (err) {
      // The RPC may have forwarded the transaction before failing, so the outcome is unknown.
      return { status: 'unknown', signature: signed.signature, error: message(err) };
    }

    let landed: boolean;
    try {
      landed = await this.deps.chain.confirm(signature, blockhash.blockhash, blockhash.lastValidBlockHeight);
    } catch (err) {
      return { status: 'unknown', signature, error: message(err) };
    }
    if (!landed) return { status: 'not_landed', signature };

    let fee = this.deps.baseFeeLamports ?? DEFAULT_BASE_FEE;
    try {
      const reported = await this.deps.chain.feeLamports?.(signature);
      if (typeof reported === 'bigint' && reported >= 0n) fee = reported;
    } catch {
      // Fall back to the base fee; reconciliation absorbs any small difference within tolerance.
    }
    try {
      await this.deps.record(job.withdrawalId, job.lamports, fee, signature);
    } catch (err) {
      return { status: 'unknown', signature, error: `landed but not booked: ${message(err)}` };
    }
    return { status: 'booked', signature, feeLamports: fee };
  }
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
