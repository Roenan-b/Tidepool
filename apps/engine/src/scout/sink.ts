import type { Logger, Queryable, SignalEvent, SignalSink } from './types.js';
import { noopLogger } from './types.js';
import type { ScoutMetrics } from './metrics.js';
import { pgSafeString, toPgJson } from './util.js';

export interface PgSignalSinkOptions {
  /** Max events held in memory; when full the oldest event is dropped and counted. */
  maxBuffer?: number;
  /** Rows per INSERT statement. */
  batchSize?: number;
  flushIntervalMs?: number;
  logger?: Logger;
  metrics?: ScoutMetrics;
}

const MAX_PAYLOAD_BYTES = 16_384;

/**
 * Persists signals to the `signals` table in small batches. `emit` is synchronous and never
 * blocks the collectors: events go to a bounded buffer that a timer drains.
 */
export class PgSignalSink implements SignalSink {
  private buffer: SignalEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private dropped = 0;
  private readonly maxBuffer: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly logger: Logger;

  constructor(
    private readonly db: Queryable,
    private readonly opts: PgSignalSinkOptions = {},
  ) {
    this.maxBuffer = opts.maxBuffer ?? 5_000;
    this.batchSize = Math.max(1, Math.min(opts.batchSize ?? 100, 500));
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.logger = opts.logger ?? noopLogger;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  get bufferedCount(): number {
    return this.buffer.length;
  }

  emit(event: SignalEvent): void {
    // An event the database would reject must not reach the buffer: a failed batch is retried
    // from the front, so one bad row would otherwise stall every later write.
    if (!(event.observedAt instanceof Date) || !Number.isFinite(event.observedAt.getTime())) {
      this.dropped++;
      this.opts.metrics?.inc('signals.invalid');
      return;
    }
    this.buffer.push(event);
    while (this.buffer.length > this.maxBuffer) {
      this.buffer.shift();
      this.dropped++;
      this.opts.metrics?.inc('signals.dropped');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  /** Writes everything currently buffered. Concurrent calls share one in-flight flush. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.drain().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      try {
        await this.insert(batch);
        this.opts.metrics?.inc('signals.written', batch.length);
      } catch (e) {
        // Put the batch back at the front if room allows; otherwise count it as dropped.
        const room = this.maxBuffer - this.buffer.length;
        const keep = batch.slice(Math.max(0, batch.length - room));
        this.dropped += batch.length - keep.length;
        this.opts.metrics?.inc('signals.dropped', batch.length - keep.length);
        this.buffer.unshift(...keep);
        this.opts.metrics?.inc('signals.write_errors');
        this.logger.warn(
          { err: e instanceof Error ? e.message : 'unknown', batch: batch.length },
          'signal batch insert failed',
        );
        return;
      }
    }
  }

  private async insert(batch: SignalEvent[]): Promise<void> {
    const params: unknown[] = [];
    const rows: string[] = [];
    for (const ev of batch) {
      let payload: string;
      try {
        payload = toPgJson(ev.payload);
      } catch {
        payload = toPgJson({ unserializable: true, kind: ev.kind });
      }
      if (payload.length > MAX_PAYLOAD_BYTES) payload = toPgJson({ truncated: true, kind: ev.kind });
      const i = params.length;
      params.push(
        pgSafeString(ev.source),
        ev.mint === null ? null : pgSafeString(ev.mint),
        pgSafeString(ev.kind),
        ev.observedAt.toISOString(),
        payload,
      );
      rows.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}::timestamptz, $${i + 5}::jsonb)`);
    }
    await this.db.query(
      `INSERT INTO signals (source, mint, kind, observed_at, payload) VALUES ${rows.join(', ')}`,
      params,
    );
  }
}

/** Keeps signals in memory; used by tests and by the Scout's recent-signal store. */
export class MemorySignalSink implements SignalSink {
  readonly events: SignalEvent[] = [];
  constructor(private readonly max = 10_000) {}
  emit(event: SignalEvent): void {
    this.events.push(event);
    if (this.events.length > this.max) this.events.shift();
  }
}

/** Sends every event to several sinks; a throwing sink cannot affect the others. */
export class FanoutSink implements SignalSink {
  constructor(private readonly sinks: SignalSink[]) {}
  emit(event: SignalEvent): void {
    for (const s of this.sinks) {
      try {
        s.emit(event);
      } catch {
        // Sinks must not throw; ignore to protect collectors.
      }
    }
  }
}
