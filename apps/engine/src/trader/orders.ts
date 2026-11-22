/**
 * Order records: one row per transaction attempt (built -> submitted -> landed | failed).
 * The Trader is the only writer of the orders table.
 */
import type { NewOrder, OrderRepository, OrderStatus } from './types.js';

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

const str = (v: bigint | null | undefined) => (v === null || v === undefined ? null : v.toString());

/**
 * Postgres implementation (parameterized SQL only). orders.config_version does not exist in
 * 001_init.sql yet, so NewOrder.configVersion is not persisted here; positions carry it via the Risk Officer.
 */
export class PgOrderRepository implements OrderRepository {
  constructor(private readonly db: Queryable) {}

  async create(o: NewOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO orders (id, mode, position_id, reservation_id, side, mint, status, lamports, token_amount, signal_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'built', $7, $8, $9)`,
      [o.id, o.mode, o.positionId, o.reservationId, o.side, o.mint, str(o.lamports), str(o.tokenAmount), o.signalAt],
    );
  }

  async markSubmitted(id: string, at: Date): Promise<void> {
    await this.expectOne(
      `UPDATE orders SET status = 'submitted', submitted_at = $2 WHERE id = $1 AND status = 'built'`,
      [id, at],
      id,
    );
  }

  async markLanded(
    id: string,
    r: { at: Date; signature: string | null; lamports: bigint; tokenAmount: bigint | null; feeLamports: bigint },
  ): Promise<void> {
    await this.expectOne(
      `UPDATE orders SET status = 'landed', landed_at = $2, signature = $3, lamports = $4, token_amount = COALESCE($5, token_amount), fee_lamports = $6
       WHERE id = $1 AND status IN ('built', 'submitted')`,
      [id, r.at, r.signature, r.lamports.toString(), str(r.tokenAmount), r.feeLamports.toString()],
      id,
    );
  }

  async markFailed(
    id: string,
    r: { at: Date; error: string; feeLamports: bigint; signature?: string | null },
  ): Promise<void> {
    // landed_at is set only when a failed transaction still landed (fee burned on chain).
    await this.expectOne(
      `UPDATE orders SET status = 'failed', error = $2, fee_lamports = $3, signature = COALESCE($4, signature),
         landed_at = CASE WHEN $4::text IS NOT NULL THEN $5 ELSE landed_at END
       WHERE id = $1 AND status IN ('built', 'submitted')`,
      [id, r.error.slice(0, 500), r.feeLamports.toString(), r.signature ?? null, r.at],
      id,
    );
  }

  async attachPosition(id: string, positionId: string): Promise<void> {
    await this.expectOne(`UPDATE orders SET position_id = $2 WHERE id = $1`, [id, positionId], id);
  }

  private async expectOne(sql: string, values: unknown[], id: string): Promise<void> {
    const r = await this.db.query(sql, values);
    if (r.rowCount !== 1) throw new Error(`order ${id}: expected one row updated, got ${r.rowCount ?? 0}`);
  }
}

export interface OrderRow extends NewOrder {
  status: OrderStatus;
  signature: string | null;
  feeLamports: bigint | null;
  submittedAt: Date | null;
  landedAt: Date | null;
  error: string | null;
}

/** In-memory implementation for tests and the backtest. Bounded: oldest rows are dropped past maxRows. */
export class InMemoryOrderRepository implements OrderRepository {
  readonly rows = new Map<string, OrderRow>();
  constructor(private readonly maxRows = 1_000_000) {}

  private get(id: string): OrderRow {
    const r = this.rows.get(id);
    if (!r) throw new Error(`order ${id} not found`);
    return r;
  }

  async create(o: NewOrder): Promise<void> {
    if (this.rows.has(o.id)) throw new Error(`order ${o.id} already exists`);
    if (this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
    this.rows.set(o.id, {
      ...o,
      status: 'built',
      signature: null,
      feeLamports: null,
      submittedAt: null,
      landedAt: null,
      error: null,
    });
  }

  async markSubmitted(id: string, at: Date): Promise<void> {
    const r = this.get(id);
    if (r.status !== 'built') throw new Error(`order ${id}: cannot submit from ${r.status}`);
    r.status = 'submitted';
    r.submittedAt = at;
  }

  async markLanded(
    id: string,
    x: { at: Date; signature: string | null; lamports: bigint; tokenAmount: bigint | null; feeLamports: bigint },
  ): Promise<void> {
    const r = this.get(id);
    if (r.status === 'landed' || r.status === 'failed') throw new Error(`order ${id}: already ${r.status}`);
    Object.assign(r, {
      status: 'landed',
      landedAt: x.at,
      signature: x.signature,
      lamports: x.lamports,
      tokenAmount: x.tokenAmount ?? r.tokenAmount,
      feeLamports: x.feeLamports,
    });
  }

  async markFailed(
    id: string,
    x: { at: Date; error: string; feeLamports: bigint; signature?: string | null },
  ): Promise<void> {
    const r = this.get(id);
    if (r.status === 'landed' || r.status === 'failed') throw new Error(`order ${id}: already ${r.status}`);
    Object.assign(r, {
      status: 'failed',
      error: x.error.slice(0, 500),
      feeLamports: x.feeLamports,
      signature: x.signature ?? r.signature,
      landedAt: x.signature ? x.at : r.landedAt,
    });
  }

  async attachPosition(id: string, positionId: string): Promise<void> {
    this.get(id).positionId = positionId;
  }

  list(): OrderRow[] {
    return [...this.rows.values()];
  }
}
