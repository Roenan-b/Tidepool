/**
 * Shared types for the Scout module. The Scout never spends money: it collects signals,
 * computes features, applies safety filters and publishes scored candidates.
 */

/** Normalized event emitted by every collector. `mint` is null when it could not be derived. */
export interface SignalEvent {
  source: SignalSource;
  mint: string | null;
  kind: string;
  observedAt: Date;
  /** JSON-serializable payload. Never contains bigint values or secrets. */
  payload: Record<string, unknown>;
}

export type SignalSource = 'dexscreener' | 'helius' | 'lunarcrush' | 'x' | 'holders' | 'scout';

/** Destination for collector output. `emit` must never block or throw. */
export interface SignalSink {
  emit(event: SignalEvent): void;
}

export interface Collector {
  readonly name: string;
  start(): void;
  stop(): Promise<void>;
}

/** Minimal structured logger; a pino logger satisfies this interface. */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Database handle subset used by the Scout. A pg.Pool or pg.Client satisfies it. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Signal kinds produced by the collectors. */
export const SignalKinds = {
  pairSnapshot: 'pair_snapshot',
  tokenProfile: 'token_profile',
  boost: 'boost',
  newToken: 'new_token',
  migration: 'migration',
  newPool: 'new_pool',
  unresolvedTx: 'unresolved_tx',
  holderSnapshot: 'holder_snapshot',
  socialMetrics: 'social_metrics',
  post: 'post',
} as const;
