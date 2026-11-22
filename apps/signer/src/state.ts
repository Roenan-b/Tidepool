import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

/**
 * Persistent signer state: used ticket reservation ids (replay protection) and the signed spend
 * total for the current UTC day. Written atomically (temp file + fsync + rename) with mode 0600.
 *
 * The file is integrity relevant (deleting it resets the daily cap), so it lives next to the keystore
 * in a directory only the signer's user can write, and the signer refuses to start if the file is
 * writable by group or other, or if it cannot be parsed (fail closed).
 */

export const MAX_TRACKED_TICKETS = 100_000;

/**
 * Used ticket ids are kept this long past their expiry before they are pruned. A backward step of the
 * system clock (NTP correction, VM restore) smaller than this cannot make a pruned, already signed
 * ticket look unexpired and unused again.
 */
export const PRUNE_GRACE_MS = 15 * 60_000;

const StateSchema = z
  .object({
    version: z.literal(1),
    usedTickets: z
      .array(z.tuple([z.string().min(1).max(128), z.number().int().nonnegative()]))
      .max(MAX_TRACKED_TICKETS),
    daily: z
      .object({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        spentLamports: z.string().regex(/^\d{1,20}$/),
      })
      .strict(),
  })
  .strict();

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

interface Snapshot {
  usedTickets: Map<string, number>; // reservationId -> ticket expiresAt (ms)
  day: string;
  spent: bigint;
}

export interface CommitInput {
  reservationId: string;
  ticketExpiresAt: number;
  amountLamports: bigint;
  nowMs: number;
}

export class SignerStateStore {
  private constructor(
    private readonly path: string,
    private snap: Snapshot,
  ) {}

  /** Opens (or initialises in memory) the state at `path`. Throws if the file is unsafe or corrupt. */
  static open(path: string, nowMs: number = Date.now()): SignerStateStore {
    if (!existsSync(path)) {
      return new SignerStateStore(path, { usedTickets: new Map(), day: utcDay(nowMs), spent: 0n });
    }
    if (process.platform !== 'win32') {
      const st = statSync(path);
      if (!st.isFile()) throw new Error('signer state path is not a regular file');
      if ((st.mode & 0o022) !== 0)
        throw new Error(`signer state file is writable by group or other; run: chmod 600 ${path}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error('signer state file is not valid JSON; refusing to start');
    }
    const parsed = StateSchema.safeParse(raw);
    if (!parsed.success) throw new Error('signer state file has an invalid format; refusing to start');
    const s = parsed.data;
    return new SignerStateStore(path, {
      usedTickets: new Map(s.usedTickets),
      day: s.daily.day,
      spent: BigInt(s.daily.spentLamports),
    });
  }

  isTicketUsed(reservationId: string): boolean {
    return this.snap.usedTickets.has(reservationId);
  }

  /**
   * The UTC day spend is booked against. It never moves backwards: if the clock steps back across
   * midnight, spend keeps accumulating on the later day instead of starting again from zero.
   */
  private effectiveDay(nowMs: number): string {
    const today = utcDay(nowMs);
    return today < this.snap.day ? this.snap.day : today;
  }

  /** Lamports signed so far on the UTC day containing `nowMs`. */
  spentOn(nowMs: number): bigint {
    return this.snap.day === this.effectiveDay(nowMs) ? this.snap.spent : 0n;
  }

  usedTicketCount(): number {
    return this.snap.usedTickets.size;
  }

  /**
   * Records a signed ticket and its spend, persisting before returning. The in-memory state only
   * changes if the write succeeds, so a failed write never leaves memory and disk out of step.
   */
  commit(input: CommitInput): void {
    if (input.amountLamports < 0n) throw new Error('negative spend');
    const today = this.effectiveDay(input.nowMs);
    const used = new Map<string, number>();
    const pruneBefore = input.nowMs - PRUNE_GRACE_MS;
    for (const [id, exp] of this.snap.usedTickets) if (exp >= pruneBefore) used.set(id, exp);
    if (used.has(input.reservationId)) throw new Error('ticket already used');
    used.set(input.reservationId, input.ticketExpiresAt);
    if (used.size > MAX_TRACKED_TICKETS) throw new Error('too many unexpired tickets tracked');
    const spent = (this.snap.day === today ? this.snap.spent : 0n) + input.amountLamports;
    const next: Snapshot = { usedTickets: used, day: today, spent };
    this.persist(next);
    this.snap = next;
  }

  private persist(next: Snapshot): void {
    const body = JSON.stringify({
      version: 1,
      usedTickets: [...next.usedTickets.entries()],
      daily: { day: next.day, spentLamports: next.spent.toString() },
    });
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const bytes = Buffer.from(body, 'utf8');
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      try {
        // writeSync may write fewer bytes than asked; a short write must never be renamed into place.
        let off = 0;
        while (off < bytes.length) {
          const n = writeSync(fd, bytes, off, bytes.length - off);
          if (n <= 0) throw new Error('short write to signer state file');
          off += n;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (process.platform !== 'win32') chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw err;
    }
    if (process.platform !== 'win32') {
      try {
        const dfd = openSync(dir, 'r');
        try {
          fsyncSync(dfd);
        } finally {
          closeSync(dfd);
        }
      } catch {
        // Directory fsync is not supported everywhere; the rename itself is still atomic.
      }
    }
  }
}
