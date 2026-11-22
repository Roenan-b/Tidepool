import { z } from 'zod';
import type { ScoutMetrics } from '../metrics.js';
import type { Collector, Logger, SignalSink } from '../types.js';
import { noopLogger, SignalKinds } from '../types.js';
import { backoffDelay, redactUrl } from '../util.js';
import { DEFAULT_STREAM_PROGRAMS, parseLogNotification, type ParsedLogEvent } from './heliusParser.js';

/** Subset of the WHATWG WebSocket API used here; Node 22's global WebSocket satisfies it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** Present on some implementations (for example the `ws` package); used for heartbeats when available. */
  ping?: () => void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;
const MAX_MESSAGE_CHARS = 1_000_000;

const notificationSchema = z.object({
  method: z.literal('logsNotification'),
  params: z.object({
    subscription: z.number(),
    result: z.object({
      context: z.object({ slot: z.number() }).partial().optional(),
      value: z.object({ signature: z.string().max(100), err: z.unknown(), logs: z.array(z.string()).nullable() }),
    }),
  }),
});

const subscribeAckSchema = z.object({ id: z.number(), result: z.number() });

export interface StreamFreshness {
  connected: boolean;
  lastMessageAt: Date | null;
  ageMs: number | null;
  stale: boolean;
  reconnects: number;
}

export interface HeliusStreamCollectorOptions {
  sink: SignalSink;
  /** WebSocket URL; may contain an API key and is never logged unredacted. */
  url: string;
  programs?: string[];
  commitment?: 'processed' | 'confirmed' | 'finalized';
  webSocketFactory?: WebSocketFactory;
  heartbeatMs?: number;
  /** No message for this long marks the stream stale and forces a reconnect. */
  staleAfterMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  logger?: Logger;
  metrics?: ScoutMetrics;
}

/**
 * Streams program logs with the standard Solana `logsSubscribe` method (one subscription per
 * program id), turns them into normalized signals, reconnects with jittered backoff, and tracks
 * freshness so the engine can halt on stale data.
 */
export class HeliusStreamCollector implements Collector {
  readonly name = 'helius';
  private ws: WebSocketLike | null = null;
  private running = false;
  private attempt = 0;
  private reconnects = 0;
  private lastMessageAt: number | null = null;
  /** Last connect attempt or frame; drives reconnects so a slow handshake is not mistaken for data loss. */
  private lastActivityAt = 0;
  /** When the current socket opened; null until it does. */
  private openedAt: number | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly programs: string[];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly factory: WebSocketFactory;

  constructor(private readonly opts: HeliusStreamCollectorOptions) {
    if (!/^wss?:\/\//.test(opts.url)) throw new Error('Helius stream URL must be ws:// or wss://');
    this.programs = opts.programs && opts.programs.length > 0 ? opts.programs : DEFAULT_STREAM_PROGRAMS;
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.factory = opts.webSocketFactory ?? ((u) => new WebSocket(u) as unknown as WebSocketLike);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    const hb = this.opts.heartbeatMs ?? 10_000;
    this.heartbeat = setInterval(() => this.checkHeartbeat(), hb);
    this.heartbeat.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000, 'shutdown');
      } catch {
        // already closed
      }
    }
    this.opts.metrics?.set('helius.connected', 0);
  }

  freshness(): StreamFreshness {
    const staleAfter = this.opts.staleAfterMs ?? 60_000;
    const age = this.lastMessageAt === null ? null : this.now() - this.lastMessageAt;
    return {
      connected: this.ws?.readyState === OPEN,
      lastMessageAt: this.lastMessageAt === null ? null : new Date(this.lastMessageAt),
      ageMs: age,
      stale: age === null ? true : age > staleAfter,
      reconnects: this.reconnects,
    };
  }

  private connect(): void {
    if (!this.running) return;
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.opts.url);
    } catch (e) {
      this.logger.warn({ url: redactUrl(this.opts.url), err: e instanceof Error ? e.name : 'Error' }, 'helius connect failed');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastActivityAt = this.now();
    this.openedAt = null;
    ws.onopen = () => {
      this.opts.metrics?.set('helius.connected', 1);
      this.lastActivityAt = this.now();
      this.openedAt = this.lastActivityAt;
      this.programs.forEach((program, i) => {
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'logsSubscribe',
            params: [{ mentions: [program] }, { commitment: this.opts.commitment ?? 'confirmed' }],
          }),
        );
      });
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => {
      this.opts.metrics?.inc('helius.socket_errors');
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.opts.metrics?.set('helius.connected', 0);
      this.resetBackoffIfHealthy();
      this.scheduleReconnect();
    };
  }

  /**
   * Backoff resets only after a connection stayed open for at least the stale window. Resetting on
   * any frame would let a server that accepts, acknowledges and then drops the socket drive a
   * reconnect loop at the minimum delay.
   */
  private resetBackoffIfHealthy(): void {
    const healthyAfter = this.opts.staleAfterMs ?? 60_000;
    if (this.openedAt !== null && this.now() - this.openedAt >= healthyAfter) this.attempt = 0;
    this.openedAt = null;
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const delay = Math.max(250, backoffDelay(this.attempt, this.opts.baseBackoffMs ?? 1_000, this.opts.maxBackoffMs ?? 30_000, this.opts.random));
    this.attempt++;
    this.reconnects++;
    this.opts.metrics?.inc('helius.reconnects');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private checkHeartbeat(): void {
    if (!this.running) return;
    const f = this.freshness();
    this.opts.metrics?.set('helius.last_message_age_ms', f.ageMs ?? -1);
    const ws = this.ws;
    if (ws && ws.readyState === OPEN && typeof ws.ping === 'function') {
      try {
        ws.ping();
      } catch {
        // ignore; staleness check below handles dead sockets
      }
    }
    if (f.stale) this.opts.metrics?.inc('helius.stale_checks');
    const staleAfter = this.opts.staleAfterMs ?? 60_000;
    if (ws && this.now() - this.lastActivityAt > staleAfter) {
      this.opts.metrics?.inc('helius.stale');
      this.logger.warn({ ageMs: f.ageMs }, 'helius stream stale; reconnecting');
      this.ws = null;
      ws.onclose = null;
      ws.onmessage = null;
      this.resetBackoffIfHealthy();
      try {
        ws.close(4000, 'stale');
      } catch {
        // ignore
      }
      this.scheduleReconnect();
    }
  }

  /** Handles one raw frame. Exposed for tests. */
  onMessage(data: unknown): void {
    this.lastMessageAt = this.now();
    this.lastActivityAt = this.lastMessageAt;
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_CHARS) {
      this.opts.metrics?.inc('helius.bad_frames');
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      this.opts.metrics?.inc('helius.bad_frames');
      return;
    }
    if (subscribeAckSchema.safeParse(msg).success) return;
    const n = notificationSchema.safeParse(msg);
    if (!n.success) {
      this.opts.metrics?.inc('helius.unrecognized_frames');
      return;
    }
    const v = n.data.params.result.value;
    const events = parseLogNotification({ signature: v.signature, err: v.err, logs: v.logs ?? [] }, this.programs);
    const slot = n.data.params.result.context?.slot ?? null;
    for (const e of events) this.emitEvent(e, slot);
  }

  private emitEvent(e: ParsedLogEvent, slot: number | null): void {
    const kind =
      e.kind === 'new_token' ? SignalKinds.newToken : e.kind === 'migration' ? SignalKinds.migration : e.kind === 'new_pool' ? SignalKinds.newPool : SignalKinds.unresolvedTx;
    this.opts.metrics?.inc(`helius.${kind}`);
    this.opts.sink.emit({
      source: 'helius',
      mint: e.mint,
      kind,
      observedAt: new Date(this.now()),
      payload: { signature: e.signature, program: e.program, instruction: e.instruction, slot, ...e.details },
    });
  }
}
