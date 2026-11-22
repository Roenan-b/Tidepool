import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { ScoutMetrics } from '../metrics.js';
import { MemorySignalSink } from '../sink.js';
import { HeliusStreamCollector, type WebSocketLike } from './helius.js';
import { anchorEventDiscriminator, PUMP_FUN_PROGRAM_ID } from './heliusParser.js';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

const MINT = new PublicKey(Buffer.alloc(32, 21));

function createEventB64(): string {
  const s = (x: string) => {
    const b = Buffer.from(x);
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return Buffer.concat([l, b]);
  };
  return Buffer.concat([anchorEventDiscriminator('CreateEvent'), s('N'), s('S'), s('u'), MINT.toBuffer(), Buffer.alloc(32, 2), Buffer.alloc(32, 3)]).toString('base64');
}

describe('HeliusStreamCollector', () => {
  let now = 1_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const sockets: FakeSocket[] = [];
    const sink = new MemorySignalSink();
    const metrics = new ScoutMetrics();
    const c = new HeliusStreamCollector({
      sink,
      url: 'wss://stream.example.com/?api-key=SECRET',
      programs: [PUMP_FUN_PROGRAM_ID],
      webSocketFactory: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      heartbeatMs: 1_000,
      staleAfterMs: 5_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      random: () => 0.99,
      now: () => now,
      metrics,
    });
    return { c, sockets, sink, metrics };
  }

  it('subscribes with logsSubscribe on open and emits parsed events', async () => {
    const { c, sockets, sink } = setup();
    c.start();
    sockets[0]!.open();
    const sub = JSON.parse(sockets[0]!.sent[0]!);
    expect(sub).toMatchObject({ method: 'logsSubscribe', params: [{ mentions: [PUMP_FUN_PROGRAM_ID] }, { commitment: 'confirmed' }] });
    sockets[0]!.deliver({ jsonrpc: '2.0', result: 77, id: 1 });
    sockets[0]!.deliver({
      jsonrpc: '2.0',
      method: 'logsNotification',
      params: {
        subscription: 77,
        result: {
          context: { slot: 5 },
          value: {
            signature: 'sigA',
            err: null,
            logs: [`Program ${PUMP_FUN_PROGRAM_ID} invoke [1]`, 'Program log: Instruction: Create', `Program data: ${createEventB64()}`, `Program ${PUMP_FUN_PROGRAM_ID} success`],
          },
        },
      },
    });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({ source: 'helius', kind: 'new_token', mint: MINT.toBase58(), payload: { signature: 'sigA', slot: 5 } });
    await c.stop();
  });

  it('reconnects with growing backoff after the server closes the socket', async () => {
    const { c, sockets, metrics } = setup();
    c.start();
    sockets[0]!.open();
    sockets[0]!.serverClose();
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(990);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);
    expect(metrics.counter('helius.reconnects')).toBe(2);
    await c.stop();
  });

  it('keeps backing off when a server acknowledges and then drops every connection', async () => {
    const { c, sockets, metrics } = setup();
    c.start();
    const ackThenDrop = (s: FakeSocket) => {
      s.open();
      s.deliver({ jsonrpc: '2.0', result: 1, id: 1 });
      s.serverClose();
    };
    ackThenDrop(sockets[0]!);
    // random 0.99 with base 1s: delays near 990, 1980, 3960, 7920 ms; an ack must not reset them.
    await vi.advanceTimersByTimeAsync(990);
    ackThenDrop(sockets[1]!);
    await vi.advanceTimersByTimeAsync(1_980);
    ackThenDrop(sockets[2]!);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(960);
    expect(sockets).toHaveLength(4);
    expect(metrics.counter('helius.reconnects')).toBe(3);

    // A connection that stays up past the stale window resets the backoff.
    sockets[3]!.open();
    now += 6_000;
    sockets[3]!.deliver({ jsonrpc: '2.0', result: 1, id: 1 });
    sockets[3]!.serverClose();
    await vi.advanceTimersByTimeAsync(990);
    expect(sockets).toHaveLength(5);
    await c.stop();
  });

  it('detects a stale stream, reports freshness and forces a reconnect', async () => {
    const { c, sockets, metrics } = setup();
    c.start();
    sockets[0]!.open();
    // Before any frame arrives the stream reports stale data, but the socket is not torn down yet.
    expect(c.freshness()).toMatchObject({ stale: true, lastMessageAt: null });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(1);
    sockets[0]!.deliver({ jsonrpc: '2.0', result: 1, id: 1 });
    expect(c.freshness().stale).toBe(false);
    now += 6_000;
    expect(c.freshness()).toMatchObject({ stale: true, connected: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(metrics.counter('helius.stale')).toBe(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(metrics.gauge('helius.last_message_age_ms')).toBe(6_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets.length).toBe(2);
    await c.stop();
  });

  it('counts malformed frames without throwing', async () => {
    const { c, sockets, metrics } = setup();
    c.start();
    sockets[0]!.open();
    sockets[0]!.onmessage?.({ data: 'not json' });
    sockets[0]!.onmessage?.({ data: new Uint8Array(3) });
    sockets[0]!.deliver({ method: 'somethingElse' });
    expect(metrics.counter('helius.bad_frames')).toBe(2);
    expect(metrics.counter('helius.unrecognized_frames')).toBe(1);
    await c.stop();
  });

  it('rejects non-websocket URLs', () => {
    expect(() => new HeliusStreamCollector({ sink: new MemorySignalSink(), url: 'https://x' })).toThrow();
  });
});
