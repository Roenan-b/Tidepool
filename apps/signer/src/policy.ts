import { createHash } from 'node:crypto';
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type MessageCompiledInstruction,
  type VersionedMessage,
} from '@solana/web3.js';
import type { ReservationTicket } from '@tidepool/core/ticket';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BASE_ALLOWED_PROGRAM_IDS,
  COMPUTE_BUDGET_PROGRAM_ID,
  DEFAULT_RENT_LIMIT_LAMPORTS,
  MAX_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WRAPPED_SOL_MINT,
  associatedTokenAddress,
} from './constants.js';

/**
 * Deny-by-default signing policy.
 *
 * The policy inspects a fully compiled transaction message (legacy or v0) and decides whether the
 * signer may add the wallet's signature. It is pure: no network, no clock, no state. Replay
 * protection and the per-day cap live in state.ts and server.ts.
 *
 * What the policy enforces
 *   - The wallet is the fee payer and the only required signer.
 *   - Every top-level program is on the allowlist; program ids must be static account keys.
 *   - System program: Transfer from the wallet to (a) configured tip accounts, (b) the wallet's own
 *     wrapped SOL associated token account for 'buy', (c) the ticket destination for 'withdraw' when
 *     it is also on the withdraw allowlist. CreateAccount / CreateAccountWithSeed only to fund a
 *     Token or Token-2022 owned account with at most the rent limit. Everything else is denied,
 *     including Assign, Allocate and every durable nonce instruction (so a signed transaction always
 *     expires with its recent blockhash).
 *   - Token programs: an explicit allowlist (InitializeAccount* owned by the wallet, SyncNative,
 *     CloseAccount to the wallet, InitializeImmutableOwner, Revoke). SetAuthority, Approve,
 *     ApproveChecked, MintTo, Burn, Freeze and all extension instructions are denied. Top-level
 *     Transfer/TransferChecked are denied unless `allowTopLevelTokenTransfers` is set, because their
 *     destination owner cannot be checked offline and Jupiter performs its token movements inside
 *     the swap instruction.
 *   - Associated Token Account program: Create / CreateIdempotent paid by and owned by the wallet, with
 *     the System program and Token or Token-2022 as the system and token program accounts.
 *   - Compute budget: SetComputeUnitLimit and SetComputeUnitPrice only, at most once each; the
 *     priority fee is capped by the tip cap.
 *   - Amount caps: non-tip SOL outflow (transfers plus rent funding) <= ticket.maxLamports and
 *     <= maxPerTxLamports; tips <= min(ticket.maxTipLamports, config.maxTipLamports). A 'sell' may
 *     not transfer SOL anywhere except tips. A 'withdraw' may use only the System and Compute
 *     Budget programs.
 *
 * Residual limits (what this policy cannot prove)
 *   - Jupiter and any extra allowlisted program are trusted as opaque instructions. Their data is not
 *     parsed, so the policy cannot see the input amount, the output mint, the minimum-out / slippage
 *     bound, the route, or token amounts moved by CPI. Those programs receive the wallet as a signer
 *     and, because the fee payer is writable at the message level, they (and any program they invoke)
 *     can move the wallet's tokens and native SOL within their own logic. Such movements are not seen
 *     by the caps here or by the per-day cap in the server. Swap quality and balance changes must be
 *     checked by the engine (quote validation, simulation).
 *   - Rent paid by CPI inside the Associated Token Account program (about 0.002 SOL per account) is
 *     not visible as a top-level transfer and is not counted.
 *   - Accounts resolved through address lookup tables cannot be checked offline. The policy denies
 *     whenever a value it must check (program id, transfer endpoints, close destination, token
 *     account owner, ATA payer/owner/system/token program) lives in a lookup table; other accounts may
 *     come from tables.
 *   - Network fees (5000 lamports per signature) are not counted.
 *   - Without simulation the policy cannot know the final balance changes of the transaction.
 */

export interface PolicyConfig {
  /** Extra program ids allowed in addition to the built-in set. Their instructions are not parsed. */
  allowedProgramIds: readonly string[];
  /** Jito / Sender tip accounts that may receive tips. */
  tipAccounts: readonly string[];
  /** Addresses a 'withdraw' ticket may send SOL to. */
  withdrawAllowlist: readonly string[];
  maxPerTxLamports: bigint;
  maxTipLamports: bigint;
  /** Cap for lamports funded into a new token account by the System program. Defaults to 0.01 SOL. */
  rentLimitLamports?: bigint;
  /** Allow top-level SPL Token Transfer / TransferChecked. Off by default. */
  allowTopLevelTokenTransfers?: boolean;
}

export type TicketForPolicy = Pick<
  ReservationTicket,
  'intent' | 'maxLamports' | 'maxTipLamports' | 'destination' | 'mint'
>;

export interface PolicyInput {
  /** A decoded transaction, or its wire bytes (Uint8Array) or base64 wire string. */
  transaction: VersionedTransaction | Transaction | Uint8Array | string;
  wallet: PublicKey;
  ticket: TicketForPolicy;
  config: PolicyConfig;
}

export interface PolicyDecision {
  allow: boolean;
  reasons: string[];
  /** Non-tip SOL leaving the wallet through top-level system instructions (transfers plus rent funding). */
  spendLamports: bigint;
  tipLamports: bigint;
  priorityFeeLamports: bigint;
}

const SYSTEM_NAMES: Record<number, string> = {
  0: 'CreateAccount',
  1: 'Assign',
  2: 'Transfer',
  3: 'CreateAccountWithSeed',
  4: 'AdvanceNonceAccount',
  5: 'WithdrawNonceAccount',
  6: 'InitializeNonceAccount',
  7: 'AuthorizeNonceAccount',
  8: 'Allocate',
  9: 'AllocateWithSeed',
  10: 'AssignWithSeed',
  11: 'TransferWithSeed',
  12: 'UpgradeNonceAccount',
};

const TOKEN_NAMES: Record<number, string> = {
  0: 'InitializeMint',
  1: 'InitializeAccount',
  2: 'InitializeMultisig',
  3: 'Transfer',
  4: 'Approve',
  5: 'Revoke',
  6: 'SetAuthority',
  7: 'MintTo',
  8: 'Burn',
  9: 'CloseAccount',
  10: 'FreezeAccount',
  11: 'ThawAccount',
  12: 'TransferChecked',
  13: 'ApproveChecked',
  14: 'MintToChecked',
  15: 'BurnChecked',
  16: 'InitializeAccount2',
  17: 'SyncNative',
  18: 'InitializeAccount3',
  19: 'InitializeMultisig2',
  20: 'InitializeMint2',
  21: 'GetAccountDataSize',
  22: 'InitializeImmutableOwner',
  23: 'AmountToUiAmount',
  24: 'UiAmountToAmount',
};

const MAX_COMPUTE_UNITS = 1_400_000n;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_SEED_LEN = 32;
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

/** Decodes base64 or raw wire bytes into a VersionedTransaction (handles legacy and v0 messages). */
export function decodeTransaction(input: Uint8Array | string): VersionedTransaction {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw new Error('transaction is not valid base64');
    bytes = Buffer.from(input, 'base64');
  } else {
    bytes = input;
  }
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) throw new Error('transaction size out of range');
  return VersionedTransaction.deserialize(bytes);
}

function toMessage(tx: PolicyInput['transaction']): VersionedMessage {
  if (tx instanceof VersionedTransaction) return tx.message;
  if (tx instanceof Transaction) return tx.compileMessage();
  return decodeTransaction(tx).message;
}

function keySet(values: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(new PublicKey(v).toBase58());
  return out;
}

/** Address derived by the System program's *WithSeed instructions: sha256(base || seed || owner). */
function addressWithSeed(base: PublicKey, seed: Buffer, owner: PublicKey): PublicKey | null {
  const ownerBytes = owner.toBuffer();
  if (ownerBytes.subarray(ownerBytes.length - PDA_MARKER.length).equals(PDA_MARKER)) return null;
  return new PublicKey(
    createHash('sha256')
      .update(Buffer.concat([base.toBuffer(), seed, ownerBytes]))
      .digest(),
  );
}

function parseAmount(label: string, value: string, reasons: string[]): bigint {
  if (!/^\d{1,20}$/.test(value)) {
    reasons.push(`ticket ${label} is malformed`);
    return 0n;
  }
  return BigInt(value);
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const reasons: string[] = [];
  const deny = (r: string): void => {
    reasons.push(r);
  };
  const result = (spend: bigint, tip: bigint, prio: bigint): PolicyDecision => ({
    allow: reasons.length === 0,
    reasons,
    spendLamports: spend,
    tipLamports: tip,
    priorityFeeLamports: prio,
  });

  let message: VersionedMessage;
  try {
    message = toMessage(input.transaction);
  } catch {
    deny('transaction could not be decoded');
    return result(0n, 0n, 0n);
  }

  const { wallet, ticket, config } = input;
  const walletB58 = wallet.toBase58();
  const keys = message.staticAccountKeys;
  const numStatic = keys.length;
  const instructions = message.compiledInstructions;
  const header = message.header;

  let tipAccounts: Set<string>;
  let withdrawAllowlist: Set<string>;
  let allowedPrograms: Set<string>;
  try {
    tipAccounts = keySet(config.tipAccounts);
    withdrawAllowlist = keySet(config.withdrawAllowlist);
    allowedPrograms = keySet([...BASE_ALLOWED_PROGRAM_IDS.map((k) => k.toBase58()), ...config.allowedProgramIds]);
  } catch {
    deny('policy configuration contains an invalid public key');
    return result(0n, 0n, 0n);
  }
  const rentLimit = config.rentLimitLamports ?? DEFAULT_RENT_LIMIT_LAMPORTS;

  // ---- Signers and fee payer ----
  if (numStatic === 0 || !keys[0]!.equals(wallet)) deny('fee payer is not the wallet');
  if (header.numRequiredSignatures !== 1) {
    deny(`transaction requires ${header.numRequiredSignatures} signatures; only the wallet may sign`);
  }
  if (header.numReadonlySignedAccounts !== 0) deny('wallet must be a writable signer');
  if (instructions.length === 0) deny('transaction has no instructions');

  // ---- Ticket fields ----
  const ticketMax = parseAmount('maxLamports', ticket.maxLamports, reasons);
  const ticketMaxTip = parseAmount('maxTipLamports', ticket.maxTipLamports, reasons);
  const intent = ticket.intent;
  if (intent !== 'buy' && intent !== 'sell' && intent !== 'withdraw') deny('unknown ticket intent');

  let withdrawDestination: string | null = null;
  if (intent === 'withdraw') {
    try {
      withdrawDestination = ticket.destination ? new PublicKey(ticket.destination).toBase58() : null;
    } catch {
      withdrawDestination = null;
    }
    if (!withdrawDestination) deny('withdraw ticket has no valid destination');
    else if (!withdrawAllowlist.has(withdrawDestination))
      deny(`withdraw destination ${withdrawDestination} is not on the allowlist`);
  }

  // Only the classic Token program owns the So111...2 native mint. The address derived for that mint
  // under Token-2022 can never be initialised as a token account, so SOL sent there would be stranded.
  const wsolAtas = new Set<string>([associatedTokenAddress(wallet, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID).toBase58()]);

  let transferSpend = 0n;
  let rentSpend = 0n;
  let tips = 0n;
  const budget: { limit: bigint | null; price: bigint | null } = { limit: null, price: null };
  let nonComputeBudgetCount = 0n;

  /** Resolves a static account referenced by an instruction, or returns null and records why. */
  const account = (ix: MessageCompiledInstruction, pos: number, label: string, where: string): PublicKey | null => {
    const idx = ix.accountKeyIndexes[pos];
    if (idx === undefined) {
      deny(`${where}: missing ${label} account`);
      return null;
    }
    if (idx >= numStatic) {
      deny(`${where}: ${label} account comes from an address lookup table and cannot be verified`);
      return null;
    }
    return keys[idx]!;
  };

  instructions.forEach((ix, i) => {
    const where = `instruction ${i}`;
    if (ix.programIdIndex >= numStatic) {
      deny(`${where}: program id is resolved from an address lookup table`);
      return;
    }
    const program = keys[ix.programIdIndex]!;
    const programB58 = program.toBase58();
    if (!allowedPrograms.has(programB58)) {
      deny(`${where}: program ${programB58} is not allowed`);
      return;
    }
    const data = Buffer.from(ix.data);
    if (!program.equals(COMPUTE_BUDGET_PROGRAM_ID)) nonComputeBudgetCount++;
    if (intent === 'withdraw' && !program.equals(SYSTEM_PROGRAM_ID) && !program.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
      deny(`${where}: withdraw transactions may only use the System and Compute Budget programs`);
      return;
    }

    // ---------------- System program ----------------
    if (program.equals(SYSTEM_PROGRAM_ID)) {
      if (data.length < 4) {
        deny(`${where}: malformed system instruction`);
        return;
      }
      const tag = data.readUInt32LE(0);
      if (tag === 2) {
        if (data.length !== 12) {
          deny(`${where}: malformed system transfer`);
          return;
        }
        const lamports = data.readBigUInt64LE(4);
        const from = account(ix, 0, 'transfer source', where);
        const to = account(ix, 1, 'transfer destination', where);
        if (!from || !to) return;
        if (!from.equals(wallet)) {
          deny(`${where}: transfer source ${from.toBase58()} is not the wallet`);
          return;
        }
        const toB58 = to.toBase58();
        if (tipAccounts.has(toB58)) {
          tips += lamports;
        } else if (toB58 === walletB58) {
          deny(`${where}: transfer to the wallet itself is not allowed`);
        } else if (intent === 'sell') {
          deny(`${where}: sell transactions may not transfer SOL except tips (to ${toB58})`);
        } else if (intent === 'buy' && wsolAtas.has(toB58)) {
          transferSpend += lamports;
        } else if (
          intent === 'withdraw' &&
          withdrawDestination !== null &&
          toB58 === withdrawDestination &&
          withdrawAllowlist.has(toB58)
        ) {
          transferSpend += lamports;
        } else {
          deny(`${where}: transfer to unapproved destination ${toB58}`);
        }
        return;
      }
      if (tag === 0 || tag === 3) {
        if (intent === 'withdraw') {
          deny(`${where}: account creation is not allowed in a withdraw transaction`);
          return;
        }
        let lamports: bigint;
        let owner: PublicKey;
        let expectedNew: PublicKey | null = null;
        if (tag === 0) {
          if (data.length !== 52) {
            deny(`${where}: malformed CreateAccount`);
            return;
          }
          lamports = data.readBigUInt64LE(4);
          owner = new PublicKey(data.subarray(20, 52));
        } else {
          // base (32) | seed: u64 length + bytes | lamports u64 | space u64 | owner (32)
          if (data.length < 4 + 32 + 8) {
            deny(`${where}: malformed CreateAccountWithSeed`);
            return;
          }
          const base = new PublicKey(data.subarray(4, 36));
          const seedLen = data.readBigUInt64LE(36);
          if (seedLen > BigInt(MAX_SEED_LEN) || data.length !== 44 + Number(seedLen) + 8 + 8 + 32) {
            deny(`${where}: malformed CreateAccountWithSeed`);
            return;
          }
          const n = Number(seedLen);
          const seed = data.subarray(44, 44 + n);
          lamports = data.readBigUInt64LE(44 + n);
          owner = new PublicKey(data.subarray(44 + n + 16, 44 + n + 48));
          if (!base.equals(wallet)) {
            deny(`${where}: CreateAccountWithSeed base must be the wallet`);
            return;
          }
          expectedNew = addressWithSeed(base, seed, owner);
        }
        const from = account(ix, 0, 'funding', where);
        const created = account(ix, 1, 'new account', where);
        if (!from || !created) return;
        if (!from.equals(wallet)) {
          deny(`${where}: account creation must be funded by the wallet`);
          return;
        }
        if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
          deny(`${where}: ${String(SYSTEM_NAMES[tag])} may only create Token or Token-2022 accounts`);
          return;
        }
        if (expectedNew !== null && !created.equals(expectedNew)) {
          deny(`${where}: CreateAccountWithSeed address does not match its seed derivation`);
          return;
        }
        if (lamports > rentLimit) {
          deny(`${where}: account funding ${lamports} exceeds rent limit ${rentLimit}`);
          return;
        }
        rentSpend += lamports;
        return;
      }
      deny(`${where}: system instruction ${SYSTEM_NAMES[tag] ?? `#${tag}`} is not allowed`);
      return;
    }

    // ---------------- Token and Token-2022 ----------------
    if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      if (data.length < 1) {
        deny(`${where}: malformed token instruction`);
        return;
      }
      const tag = data[0]!;
      const name = TOKEN_NAMES[tag] ?? `#${tag}`;
      switch (tag) {
        case 1: {
          const owner = account(ix, 2, 'token account owner', where);
          if (owner && !owner.equals(wallet)) deny(`${where}: InitializeAccount owner must be the wallet`);
          return;
        }
        case 16:
        case 18: {
          if (data.length !== 33) {
            deny(`${where}: malformed ${name}`);
            return;
          }
          if (!new PublicKey(data.subarray(1, 33)).equals(wallet)) deny(`${where}: ${name} owner must be the wallet`);
          return;
        }
        case 9: {
          const dest = account(ix, 1, 'close destination', where);
          if (dest && !dest.equals(wallet))
            deny(`${where}: CloseAccount destination ${dest.toBase58()} is not the wallet`);
          return;
        }
        case 17: // SyncNative
        case 22: // InitializeImmutableOwner
        case 5: // Revoke
          return;
        case 3:
        case 12:
          if (!config.allowTopLevelTokenTransfers) deny(`${where}: top-level token ${name} is not allowed`);
          return;
        case 4:
        case 13:
          deny(`${where}: token delegation (${name}) is not allowed`);
          return;
        case 6:
          deny(`${where}: token SetAuthority is not allowed`);
          return;
        default:
          deny(`${where}: token instruction ${name} is not allowed`);
          return;
      }
    }

    // ---------------- Associated Token Account ----------------
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const tag = data.length === 0 ? 0 : data[0]!;
      if (data.length > 1 || (tag !== 0 && tag !== 1)) {
        deny(`${where}: associated token instruction #${tag} is not allowed`);
        return;
      }
      const payer = account(ix, 0, 'ATA payer', where);
      const owner = account(ix, 2, 'ATA owner', where);
      // The ATA program does not restrict the token program it is handed: it asks that program for the
      // account size (GetAccountDataSize), then has the payer fund rent for that size and assigns the
      // new account to that program. A rogue "token program" could report up to 10 MiB and receive
      // about 73 SOL of wallet funds per instruction, outside every cap. Pin both CPI targets.
      const systemProgram = account(ix, 4, 'ATA system program', where);
      const tokenProgram = account(ix, 5, 'ATA token program', where);
      if (payer && !payer.equals(wallet)) deny(`${where}: ATA payer must be the wallet`);
      if (owner && !owner.equals(wallet)) deny(`${where}: ATA owner must be the wallet`);
      if (systemProgram && !systemProgram.equals(SYSTEM_PROGRAM_ID))
        deny(`${where}: ATA system program account must be the System program`);
      if (tokenProgram && !tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        deny(`${where}: ATA token program ${tokenProgram.toBase58()} must be Token or Token-2022`);
      }
      return;
    }

    // ---------------- Compute budget ----------------
    if (program.equals(COMPUTE_BUDGET_PROGRAM_ID)) {
      const tag = data.length > 0 ? data[0]! : -1;
      if (tag === 2 && data.length === 5) {
        if (budget.limit !== null) deny(`${where}: duplicate SetComputeUnitLimit`);
        budget.limit = BigInt(data.readUInt32LE(1));
        return;
      }
      if (tag === 3 && data.length === 9) {
        if (budget.price !== null) deny(`${where}: duplicate SetComputeUnitPrice`);
        budget.price = data.readBigUInt64LE(1);
        return;
      }
      deny(`${where}: compute budget instruction #${tag} is not allowed`);
      return;
    }

    // Jupiter and configured extra programs: allowed as opaque instructions (see residual limits).
  });

  // ---- Priority fee ----
  // Without an explicit limit the runtime grants 200k units per non-compute-budget instruction.
  const requestedUnits = budget.limit ?? DEFAULT_UNITS_PER_INSTRUCTION * nonComputeBudgetCount;
  const units = requestedUnits < MAX_COMPUTE_UNITS ? requestedUnits : MAX_COMPUTE_UNITS;
  const priorityFee = ((budget.price ?? 0n) * units + 999_999n) / 1_000_000n; // ceil(microLamports * units / 1e6)

  // ---- Caps ----
  const tipCap = ticketMaxTip < config.maxTipLamports ? ticketMaxTip : config.maxTipLamports;
  if (tips > tipCap) deny(`tips ${tips} exceed cap ${tipCap}`);
  if (priorityFee > tipCap) deny(`priority fee ${priorityFee} exceeds cap ${tipCap}`);
  const spend = transferSpend + rentSpend;
  if (spend > ticketMax) deny(`SOL outflow ${spend} exceeds ticket maximum ${ticketMax}`);
  if (spend > config.maxPerTxLamports)
    deny(`SOL outflow ${spend} exceeds per-transaction cap ${config.maxPerTxLamports}`);

  return result(spend, tips, priorityFee);
}
