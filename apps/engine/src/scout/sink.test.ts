import { describe, expect, it } from 'vitest';
import { ScoutMetrics } from './metrics.js';
import { FanoutSink, MemorySignalSink, PgSignalSink } from './sink.js';
import type { Queryable, SignalEvent } from './types.js';

const ev = (i: number): SignalEvent => ({ source: 'dexscreener', mint: `m${i}`, kind: 'k', observedAt: new Date(0), payload: { i } });

function fakeDb(fail = false) {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const db: Queryable = {
    query: async (text: string, params?: unknown[]) => {
      if (fail) throw new Error('db down');
      queries.push({ text, params: params ?? [] });
      return { rows: [] };
    },
  };
  return { db, queries };
}

describe('PgSignalSink', () => {
  it('inserts in parameterized batches', async () => {
    const { db, queries } = fakeDb();
    const sink = new PgSignalSink(db, { batchSize: 3 });
    for (let i = 0; i < 7; i++) sink.emit(ev(i));
    await sink.flush();
    expect(queries.map((q) => q.params.length / 5)).toEqual([3, 3, 1]);
    expect(queries[0]!.text).toContain('$15::jsonb');
    expect(queries[0]!.params[4]).toBe('{"i":0}');
  });

  it('drops the oldest events when the buffer is full and counts them', () => {
    const metrics = new ScoutMetrics();
    const sink = new PgSignalSink(fakeDb().db, { maxBuffer: 3, metrics });
    for (let i = 0; i < 5; i++) sink.emit(ev(i));
    expect(sink.bufferedCount).toBe(3);
    expect(sink.droppedCount).toBe(2);
    expect(metrics.counter('signals.dropped')).toBe(2);
  });

  it('keeps events for retry on a failed write without exceeding the bound', async () => {
    const sink = new PgSignalSink(fakeDb(true).db, { maxBuffer: 4, batchSize: 2 });
    for (let i = 0; i < 4; i++) sink.emit(ev(i));
    await sink.flush();
    expect(sink.bufferedCount).toBe(4);
    expect(sink.droppedCount).toBe(0);
  });

  it('truncates oversized payloads', async () => {
    const { db, queries } = fakeDb();
    const sink = new PgSignalSink(db);
    sink.emit({ ...ev(1), payload: { blob: 'x'.repeat(50_000) } });
    await sink.flush();
    expect(queries[0]!.params[4]).toBe('{"truncated":true,"kind":"k"}');
  });
});

describe('FanoutSink', () => {
  it('isolates a throwing sink', () => {
    const mem = new MemorySignalSink();
    const f = new FanoutSink([{ emit: () => { throw new Error('x'); } }, mem]);
    f.emit(ev(1));
    expect(mem.events).toHaveLength(1);
  });
});
