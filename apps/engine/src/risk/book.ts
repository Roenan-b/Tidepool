import type { TradingMode } from '@tidepool/core';
import type { Queryable } from '../db/pool.js';
import { toBig } from '../db/pool.js';

/** Sleeve name used for withdrawal holds in the reservations table (never a strategy). */
export const WITHDRAWAL_SLEEVE = '__withdrawal';

/**
 * Book convention: pool_state.cash_lamports is all SOL the books say the wallet holds, including
 * SOL earmarked by held reservations (earmarks do not move SOL). Therefore:
 *   free cash  = cash - fee reserve - held reservations
 *   equity     = cash + marked value of open and closing positions
 *   chain SOL  = cash (the hard reconciliation check)
 *   sum(ledger_entries) = cash (internal consistency invariant)
 */
export interface BookTotals {
  heldLamports: bigint;
  /** Held reservations that will become positions (withdrawal holds excluded). */
  heldEntryCount: number;
  inPositionsLamports: bigint; // sum of mark (or entry when unmarked) of open and closing positions
  costBasisLamports: bigint; // sum of entry_lamports of open and closing positions
  openCount: number;
  closingCount: number;
}

export async function loadBookTotals(q: Queryable, mode: TradingMode): Promise<BookTotals> {
  const res = await q.query<{
    held: string;
    held_entry_count: string;
    in_positions: string;
    cost_basis: string;
    open_count: string;
    closing_count: string;
  }>(
    `SELECT
       (SELECT coalesce(sum(lamports), 0)::text FROM reservations WHERE mode = $1 AND status = 'held') AS held,
       (SELECT count(*)::text FROM reservations WHERE mode = $1 AND status = 'held' AND sleeve <> $2) AS held_entry_count,
       (SELECT coalesce(sum(coalesce(mark_lamports, entry_lamports)), 0)::text FROM positions WHERE mode = $1 AND status <> 'closed') AS in_positions,
       (SELECT coalesce(sum(entry_lamports), 0)::text FROM positions WHERE mode = $1 AND status <> 'closed') AS cost_basis,
       (SELECT count(*)::text FROM positions WHERE mode = $1 AND status = 'open') AS open_count,
       (SELECT count(*)::text FROM positions WHERE mode = $1 AND status = 'closing') AS closing_count`,
    [mode, WITHDRAWAL_SLEEVE],
  );
  const r = res.rows[0]!;
  return {
    heldLamports: toBig(r.held),
    heldEntryCount: Number(r.held_entry_count),
    inPositionsLamports: toBig(r.in_positions),
    costBasisLamports: toBig(r.cost_basis),
    openCount: Number(r.open_count),
    closingCount: Number(r.closing_count),
  };
}

export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
