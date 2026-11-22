import { describe, expect, it } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import type { SignedTicket } from '@tidepool/core/ticket';
import { evaluatePolicy } from '../../../signer/src/policy.js';
import type { SignRequest, SignerClient } from '../trader/signerClient.js';
import { WithdrawalExecutor, type WithdrawalChain, type WithdrawalJob } from './withdrawals.js';

const wallet = Keypair.generate();
const dest = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

const ticket = {
  ticket: {
    v: 1,
    reservationId: 'r',
    intent: 'withdraw',
    mint: null,
    maxLamports: '1000000',
    maxTipLamports: '0',
    destination: dest,
    issuedAt: 0,
    expiresAt: 1,
  },
  mac: 'x',
} as unknown as SignedTicket;
const job: WithdrawalJob = {
  withdrawalId: '00000000-0000-4000-8000-000000000001',
  lamports: 1_000_000n,
  destination: dest,
  ticket,
};

/** Signs only what the real signer policy would allow. */
function policySigner(allowlist: string[]): SignerClient & { seen: SignRequest[] } {
  const seen: SignRequest[] = [];
  return {
    seen,
    async sign(req) {
      seen.push(req);
      const decision = evaluatePolicy({
        transaction: req.transactionBase64,
        wallet: wallet.publicKey,
        ticket: { intent: 'withdraw', maxLamports: '1000000', maxTipLamports: '0', destination: dest, mint: null },
        config: {
          allowedProgramIds: [],
          tipAccounts: [],
          withdrawAllowlist: allowlist,
          maxPerTxLamports: 10_000_000n,
          maxTipLamports: 0n,
        },
      });
      if (!decision.allow) throw new Error(`refused: ${decision.reasons.join('; ')}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(req.transactionBase64, 'base64'));
      tx.sign([wallet]);
      return { signedTransactionBase64: Buffer.from(tx.serialize()).toString('base64'), signature: 'sig1' };
    },
  };
}

function chain(o: Partial<WithdrawalChain> = {}): WithdrawalChain {
  return {
    latestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    sendRaw: async () => 'sig1',
    confirm: async () => true,
    feeLamports: async () => 5_000n,
    ...o,
  };
}

describe('WithdrawalExecutor', () => {
  it('builds a transfer the signer policy accepts and books it only after confirmation', async () => {
    const booked: unknown[] = [];
    const signer = policySigner([dest]);
    const ex = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer,
      chain: chain(),
      record: async (...a) => {
        booked.push(a);
      },
    });
    const out = await ex.execute(job);
    expect(out).toEqual({ status: 'booked', signature: 'sig1', feeLamports: 5_000n });
    expect(booked).toEqual([[job.withdrawalId, 1_000_000n, 5_000n, 'sig1']]);
    expect(signer.seen[0]!.ticket).toBe(ticket);
  });

  it('books nothing when the signer refuses (destination not allowlisted)', async () => {
    const booked: unknown[] = [];
    const ex = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([]),
      chain: chain(),
      record: async (...a) => {
        booked.push(a);
      },
    });
    const out = await ex.execute(job);
    expect(out.status).toBe('refused');
    expect(booked).toEqual([]);
  });

  it('books nothing when the transaction does not land or the outcome is unknown', async () => {
    const booked: unknown[] = [];
    const record = async (...a: unknown[]) => {
      booked.push(a);
    };
    const notLanded = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([dest]),
      chain: chain({ confirm: async () => false }),
      record,
    });
    expect((await notLanded.execute(job)).status).toBe('not_landed');
    const timeout = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([dest]),
      chain: chain({
        confirm: async () => {
          throw new Error('timeout');
        },
      }),
      record,
    });
    expect((await timeout.execute(job)).status).toBe('unknown');
    const sendFail = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([dest]),
      chain: chain({
        sendRaw: async () => {
          throw new Error('rpc down');
        },
      }),
      record,
    });
    expect((await sendFail.execute(job)).status).toBe('unknown');
    expect(booked).toEqual([]);
  });

  it('runs one execution per withdrawal at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ex = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([dest]),
      chain: chain({
        confirm: async () => {
          await gate;
          return true;
        },
      }),
      record: async () => {},
    });
    const first = ex.execute(job);
    expect(await ex.execute(job)).toEqual({ status: 'refused', error: 'withdrawal already in flight' });
    release();
    expect((await first).status).toBe('booked');
  });

  it('falls back to the base fee when the RPC cannot report one', async () => {
    const ex = new WithdrawalExecutor({
      wallet: wallet.publicKey,
      signer: policySigner([dest]),
      chain: chain({ feeLamports: async () => null }),
      record: async () => {},
    });
    expect(await ex.execute(job)).toMatchObject({ status: 'booked', feeLamports: 5_000n });
  });
});
