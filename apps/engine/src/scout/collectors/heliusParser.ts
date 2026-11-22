import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { sanitizeText } from '../util.js';

/*
 * Best-effort extraction of new tokens, migrations and new pools from transaction log lines
 * delivered by `logsSubscribe`. Only logs emitted while the expected program is the active frame
 * of the invoke stack are trusted, so another program in the same transaction cannot spoof an
 * event by printing look-alike lines. When a mint cannot be derived, the result carries only the
 * signature so a later enrichment step can resolve it; nothing is guessed.
 */

export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_SWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

export const DEFAULT_STREAM_PROGRAMS = [PUMP_FUN_PROGRAM_ID, PUMP_SWAP_PROGRAM_ID, RAYDIUM_AMM_V4_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID];

export type ParsedKind = 'new_token' | 'migration' | 'new_pool' | 'unresolved_tx';

export interface ParsedLogEvent {
  kind: ParsedKind;
  program: string;
  instruction: string;
  signature: string;
  /** Null when the logs do not carry the mint; enrichment must resolve it from the transaction. */
  mint: string | null;
  details: Record<string, string>;
}

export interface LogNotification {
  signature: string;
  err: unknown;
  logs: string[];
}

/** Anchor event discriminator: first 8 bytes of sha256("event:<Name>"). */
export function anchorEventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const CREATE_EVENT = anchorEventDiscriminator('CreateEvent');
const COMPLETE_EVENT = anchorEventDiscriminator('CompleteEvent');

/** Instruction names (from "Program log: Instruction: X") that indicate a listing event per program. */
const INSTRUCTION_KINDS: Record<string, Record<string, ParsedKind>> = {
  [PUMP_FUN_PROGRAM_ID]: { Create: 'new_token', CreateV2: 'new_token', Migrate: 'migration' },
  [PUMP_SWAP_PROGRAM_ID]: { CreatePool: 'new_pool' },
  [RAYDIUM_CPMM_PROGRAM_ID]: { Initialize: 'new_pool' },
};

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  remaining(): number {
    return this.buf.length - this.off;
  }
  string(maxLen: number): string {
    if (this.remaining() < 4) throw new RangeError('short buffer');
    const len = this.buf.readUInt32LE(this.off);
    this.off += 4;
    if (len > maxLen || len > this.remaining()) throw new RangeError('bad string length');
    const s = this.buf.subarray(this.off, this.off + len).toString('utf8');
    this.off += len;
    return s;
  }
  pubkey(): string {
    if (this.remaining() < 32) throw new RangeError('short buffer');
    const pk = new PublicKey(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return pk.toBase58();
  }
}

/** Decodes a pump.fun CreateEvent or CompleteEvent payload. Returns null for any other data. */
export function decodePumpEvent(b64: string): { event: 'create' | 'complete'; mint: string; details: Record<string, string> } | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 8 + 32) return null;
  const disc = buf.subarray(0, 8);
  try {
    if (disc.equals(CREATE_EVENT)) {
      const r = new Reader(buf.subarray(8));
      const name = r.string(200);
      const symbol = r.string(50);
      const uri = r.string(400);
      const mint = r.pubkey();
      const bondingCurve = r.pubkey();
      const user = r.pubkey();
      const details: Record<string, string> = {
        name: sanitizeText(name, 64),
        symbol: sanitizeText(symbol, 16),
        uri: sanitizeText(uri, 256),
        bondingCurve,
        user,
      };
      // Newer program versions append the creator after the user; read it only when present.
      if (r.remaining() >= 32) details.creator = r.pubkey();
      return { event: 'create', mint, details };
    }
    if (disc.equals(COMPLETE_EVENT)) {
      const r = new Reader(buf.subarray(8));
      const user = r.pubkey();
      const mint = r.pubkey();
      const bondingCurve = r.pubkey();
      return { event: 'complete', mint, details: { user, bondingCurve } };
    }
  } catch {
    return null;
  }
  return null;
}

const INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/;
const EXIT_RE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed.*)$/;
const INSTRUCTION_RE = /^Program log: Instruction: ([A-Za-z0-9_]{1,40})$/;
const DATA_RE = /^Program data: ([A-Za-z0-9+/=]{1,8000})$/;

/**
 * Parses one log notification into zero or more listing events. Failed transactions yield nothing.
 * `programs` limits which program ids are recognized.
 */
export function parseLogNotification(n: LogNotification, programs: readonly string[] = DEFAULT_STREAM_PROGRAMS): ParsedLogEvent[] {
  if (n.err !== null && n.err !== undefined) return [];
  const allowed = new Set(programs);
  const stack: string[] = [];
  const found: ParsedLogEvent[] = [];
  const pending: Array<{ program: string; instruction: string; kind: ParsedKind }> = [];

  for (const raw of n.logs.slice(0, 2000)) {
    const line = typeof raw === 'string' ? raw : '';
    let m = INVOKE_RE.exec(line);
    if (m) {
      stack.push(m[1]!);
      continue;
    }
    m = EXIT_RE.exec(line);
    if (m) {
      if (stack[stack.length - 1] === m[1]) stack.pop();
      continue;
    }
    const current = stack[stack.length - 1];
    if (!current || !allowed.has(current)) continue;

    m = INSTRUCTION_RE.exec(line);
    if (m) {
      const kind = INSTRUCTION_KINDS[current]?.[m[1]!];
      if (kind) pending.push({ program: current, instruction: m[1]!, kind });
      continue;
    }
    if (current === RAYDIUM_AMM_V4_PROGRAM_ID && line.startsWith('Program log: initialize2: InitializeInstruction2')) {
      pending.push({ program: current, instruction: 'initialize2', kind: 'new_pool' });
      continue;
    }
    if (current === PUMP_FUN_PROGRAM_ID) {
      m = DATA_RE.exec(line);
      if (m) {
        const ev = decodePumpEvent(m[1]!);
        if (!ev) continue;
        const kind: ParsedKind = ev.event === 'create' ? 'new_token' : 'migration';
        found.push({ kind, program: current, instruction: ev.event === 'create' ? 'Create' : 'Complete', signature: n.signature, mint: ev.mint, details: ev.details });
      }
    }
  }

  // Instructions whose mint was not recovered from event data are reported for enrichment.
  for (const p of pending) {
    const resolved = found.some((f) => f.program === p.program && (f.kind === p.kind || (p.kind === 'migration' && f.kind === 'migration')));
    if (!resolved) {
      found.push({ kind: 'unresolved_tx', program: p.program, instruction: p.instruction, signature: n.signature, mint: null, details: { intendedKind: p.kind } });
    }
  }

  // De-duplicate by kind and mint (a CompleteEvent and Migrate can appear in one transaction).
  const seen = new Set<string>();
  return found.filter((f) => {
    const key = `${f.kind}:${f.mint ?? f.instruction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
