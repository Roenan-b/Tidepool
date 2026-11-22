import { resolve } from 'node:path';
import type { Preset, TokenSafety, TradingMode } from '@tidepool/core';
import type { CandidateSource, Clock } from '../contracts.js';
import { systemClock } from '../contracts.js';
import { PgCandidateStore, type CandidateRow, type CandidateStore } from './candidates.js';
import { DexScreenerCollector } from './collectors/dexscreener.js';
import { HeliusStreamCollector, type StreamFreshness, type WebSocketFactory } from './collectors/helius.js';
import { HeliusDasHolderCounter, HolderStatsCollector, type HolderCountProvider } from './collectors/holders.js';
import { LunarCrushCollector } from './collectors/lunarcrush.js';
import { XCuratedCollector } from './collectors/x.js';
import { computeFeatures, DEFAULT_FEATURE_CONFIG, type FeatureConfig, type NarrativeEntry } from './features.js';
import { evaluateCooldown, evaluateSafety, FilterReasons } from './filters.js';
import { HttpClient } from './http.js';
import { ScoutMetrics } from './metrics.js';
import {
  createNarrativeClassifier,
  PgNarrativeStore,
  type NarrativeClassifier,
  type NarrativeConfig,
  type NarrativeStore,
} from './narrative.js';
import { CreatorBlocklist, OnChainSafetyChecker, type SafetyRpc, type SellQuoter } from './safety.js';
import { buildCandidate, DEFAULT_SCORING_CONFIG, type ScoringConfig } from './scoring.js';
import { PgSignalSink } from './sink.js';
import { isSurfacingEvent, RecentSignalStore, Watchlist } from './state.js';
import type { Collector, FetchLike, Logger, Queryable, SignalEvent, SignalSink } from './types.js';
import { noopLogger, SignalKinds } from './types.js';
import { LruMap } from './util.js';

/** Safety facts provider used by the cycle. `hasFresh` lets the cycle spend RPC budget on uncached mints only. */
export interface ScoutSafety {
  check(mint: string, sizeLamports: bigint): Promise<TokenSafety>;
  hasFresh?(mint: string): boolean;
}

export interface ScoutCycleConfig {
  cycleIntervalMs: number;
  candidateTtlMs: number;
  maxMintsPerCycle: number;
  /** Uncached safety lookups allowed per cycle (each costs about three RPC calls). */
  maxSafetyChecksPerCycle: number;
  safetyConcurrency: number;
  features: FeatureConfig;
  scoring: ScoringConfig;
}

export const DEFAULT_CYCLE_CONFIG: ScoutCycleConfig = {
  cycleIntervalMs: 3_000,
  candidateTtlMs: 90_000,
  maxMintsPerCycle: 150,
  maxSafetyChecksPerCycle: 10,
  safetyConcurrency: 4,
  features: DEFAULT_FEATURE_CONFIG,
  scoring: DEFAULT_SCORING_CONFIG,
};

/** Safety failures that cannot recover soon; such mints leave the watchlist for an hour. */
const PERMANENT_REASONS = [
  FilterReasons.mintAuthority,
  FilterReasons.freezeAuthority,
  FilterReasons.bannedExtension,
  FilterReasons.unvettedExtension,
  FilterReasons.creator,
];

export interface ScoutOptions {
  /** Persistent sink for raw signals (normally PgSignalSink). */
  persist: SignalSink & { start?(): void; stop?(): Promise<void> };
  store: CandidateStore;
  safety: ScoutSafety;
  preset: () => Preset;
  mode?: () => TradingMode;
  narrativeStore?: NarrativeStore;
  classifier?: NarrativeClassifier;
  clock?: Clock;
  logger?: Logger;
  metrics?: ScoutMetrics;
  config?: Partial<ScoutCycleConfig>;
  watchlistSize?: number;
}

export interface CycleReport {
  at: Date;
  considered: number;
  published: number;
  vetoed: number;
  deferred: number;
  expiredDeleted: number;
}

/**
 * Orchestrates collectors and runs the feature, filter and score cycle. It never spends money and
 * never awaits a model call: narrative scores are read from the cache only.
 */
export class Scout implements CandidateSource {
  readonly metrics: ScoutMetrics;
  readonly recent: RecentSignalStore;
  readonly watchlist: Watchlist;
  /** Tee sink handed to collectors: persists, feeds recent state, updates the watchlist. */
  readonly sink: SignalSink;
  private readonly collectors: Collector[] = [];
  private readonly cfg: ScoutCycleConfig;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private cycleRunning: Promise<CycleReport | null> | null = null;
  private streamFreshness: (() => StreamFreshness) | null = null;
  private lastCycle: CycleReport | null = null;
  private readonly safetyAttemptAt = new LruMap<string, number>(5_000);

  constructor(private readonly opts: ScoutOptions) {
    this.cfg = { ...DEFAULT_CYCLE_CONFIG, ...(opts.config ?? {}) };
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? noopLogger;
    this.metrics = opts.metrics ?? new ScoutMetrics();
    const now = () => this.clock.now().getTime();
    this.recent = new RecentSignalStore({}, now);
    this.watchlist = new Watchlist(opts.watchlistSize ?? 300, 60 * 60_000, now);
    this.sink = {
      emit: (ev: SignalEvent) => {
        this.metrics.inc(`signals.${ev.source}`);
        try {
          opts.persist.emit(ev);
        } catch {
          this.metrics.inc('signals.persist_errors');
        }
        this.recent.add(ev);
        if (isSurfacingEvent(ev)) {
          // A bare launch waits in the holding tier until it is old enough for the active preset.
          const launchOnly = ev.source === 'helius' && ev.kind === SignalKinds.newToken;
          this.watchlist.touch(ev.mint!, `${ev.source}:${ev.kind}`, launchOnly);
        }
      },
    };
  }

  addCollector(c: Collector): void {
    this.collectors.push(c);
    if (c instanceof HeliusStreamCollector) this.streamFreshness = () => c.freshness();
  }

  watchedMints(): string[] {
    return this.watchlist.mints();
  }

  /** Watched tokens with a known symbol (from the latest pair snapshot). */
  watchedTokens(): { mint: string; symbol: string }[] {
    const out: { mint: string; symbol: string }[] = [];
    for (const mint of this.watchlist.mints()) {
      const s = this.recent.latest(mint, SignalKinds.pairSnapshot);
      const sym = typeof s?.payload.symbol === 'string' ? s.payload.symbol : '';
      if (sym) out.push({ mint, symbol: sym });
    }
    return out;
  }

  /** Upper-case symbol to mint, for attaching cashtag-only posts. Ambiguous symbols are left out. */
  watchedSymbolMap(): Map<string, string> {
    const map = new Map<string, string>();
    const dup = new Set<string>();
    for (const t of this.watchedTokens()) {
      const k = t.symbol.toUpperCase();
      if (map.has(k)) dup.add(k);
      map.set(k, t.mint);
    }
    for (const k of dup) map.delete(k);
    return map;
  }

  freshness(): { stream: StreamFreshness | null; lastCycleAt: Date | null } {
    return { stream: this.streamFreshness?.() ?? null, lastCycleAt: this.lastCycle?.at ?? null };
  }

  start(): void {
    if (this.timer) return;
    this.opts.persist.start?.();
    for (const c of this.collectors) c.start();
    this.opts.classifier?.start();
    this.timer = setInterval(() => void this.tick(), this.cfg.cycleIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled(this.collectors.map((c) => c.stop()));
    await this.opts.classifier?.stop();
    await this.cycleRunning;
    await this.opts.persist.stop?.();
  }

  private tick(): Promise<CycleReport | null> {
    if (this.cycleRunning) return this.cycleRunning;
    this.cycleRunning = this.runCycle()
      .catch((e: unknown) => {
        this.metrics.inc('cycle.errors');
        this.logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'scout cycle failed');
        return null;
      })
      .finally(() => {
        this.cycleRunning = null;
      });
    return this.cycleRunning;
  }

  topCandidates(limit: number, now: Date) {
    return this.opts.store.topCandidates(limit, now);
  }

  /** One feature, filter and score pass over the watchlist. */
  async runCycle(): Promise<CycleReport> {
    const now = this.clock.now();
    const preset = this.opts.preset();
    const mode = this.opts.mode?.() ?? 'paper';
    const promoted = this.watchlist.promoteMature(preset.filters.minAgeSeconds * 1000, this.cfg.maxMintsPerCycle);
    if (promoted > 0) this.metrics.inc('watchlist.promoted', promoted);
    const mints = this.watchlist.mints().slice(0, this.cfg.maxMintsPerCycle);

    let narratives = new Map<string, NarrativeEntry>();
    if (this.opts.narrativeStore && mints.length > 0) {
      try {
        narratives = await this.opts.narrativeStore.getMany(mints);
      } catch {
        this.metrics.inc('cycle.narrative_read_errors');
      }
    }
    // A failed cooldown lookup aborts the cycle rather than publishing tokens that may be cooling down.
    const cooldowns = await this.opts.store.activeCooldowns(mode, mints, now);

    const work: (() => Promise<CandidateRow | null>)[] = [];
    const uncached: { mint: string; task: () => Promise<CandidateRow | null> }[] = [];

    for (const mint of mints) {
      const fr = computeFeatures(mint, this.recent.get(mint), now, narratives.get(mint) ?? null, this.cfg.features);
      if (!fr) continue;
      const f = preset.filters;
      const ageSeconds = fr.meta.pairCreatedAt
        ? Math.max(0, Math.floor((now.getTime() - fr.meta.pairCreatedAt.getTime()) / 1000))
        : 0;
      const pre: string[] = [];
      if (fr.features.liquidityUsd < f.minLiquidityUsd) pre.push(FilterReasons.liquidity);
      if (ageSeconds < f.minAgeSeconds) pre.push(FilterReasons.tooNew);
      if (ageSeconds > f.maxAgeSeconds) pre.push(FilterReasons.tooOld);
      const cooldown = evaluateCooldown(cooldowns.get(mint) ?? null, now);

      if (pre.length > 0) {
        // Cheap market prefilter: no RPC spent. Safety is recorded as unchecked.
        const safety: TokenSafety = {
          mint,
          mintAuthorityRevoked: false,
          freezeAuthorityRevoked: false,
          token2022Extensions: [],
          liquidityUsd: fr.features.liquidityUsd,
          top10HolderShare: 1,
          creatorFlagged: false,
          ageSeconds,
          sellSimulationRatio: null,
        };
        const veto = [...pre.map((r) => `prefilter:${r}`), ...cooldown.reasons].join(',');
        work.push(async () => this.row(mint, fr, safety, veto, ['safety_not_checked']));
        continue;
      }

      const task = async (): Promise<CandidateRow | null> => {
        let safety: TokenSafety;
        try {
          safety = await this.opts.safety.check(mint, 0n);
        } catch (e) {
          this.metrics.inc('cycle.safety_errors');
          this.logger.debug({ mint, err: e instanceof Error ? e.message : 'unknown' }, 'safety check failed');
          return null;
        }
        // Sell simulation is size-dependent and deferred to the Risk Officer's re-check.
        const res = evaluateSafety(safety, preset.filters, { allowMissingSellSimulation: true });
        const reasons = [...res.reasons, ...cooldown.reasons];
        if (res.reasons.some((r) => PERMANENT_REASONS.some((p) => r.startsWith(p)))) this.watchlist.block(mint);
        const extra = safety.sellSimulationRatio === null ? ['sell_simulation_deferred_to_risk_check'] : [];
        if (reasons.length === 0) this.enqueueNarrative(mint, fr.meta.name, fr.meta.symbol);
        return this.row(mint, fr, safety, reasons.length > 0 ? reasons.join(',') : null, extra);
      };
      if (this.opts.safety.hasFresh?.(mint) ?? false) work.push(task);
      else uncached.push({ mint, task });
    }

    // Spend the per-cycle RPC budget on the mints whose last lookup is oldest, so a mint that keeps
    // failing cannot starve the others.
    uncached.sort((a, b) => (this.safetyAttemptAt.peek(a.mint) ?? 0) - (this.safetyAttemptAt.peek(b.mint) ?? 0));
    const chosen = uncached.slice(0, Math.max(0, this.cfg.maxSafetyChecksPerCycle));
    for (const u of chosen) {
      this.safetyAttemptAt.set(u.mint, now.getTime());
      work.push(u.task);
    }
    const deferred = uncached.length - chosen.length;

    const rows = (await runLimited(work, this.cfg.safetyConcurrency)).filter((r): r is CandidateRow => r !== null);
    await this.opts.store.upsertMany(rows);
    const expiredDeleted = await this.opts.store.deleteExpired(now);
    const vetoed = rows.filter((r) => r.vetoReason !== null).length;
    const report: CycleReport = {
      at: now,
      considered: mints.length,
      published: rows.length - vetoed,
      vetoed,
      deferred,
      expiredDeleted,
    };
    this.lastCycle = report;
    this.metrics.inc('cycle.runs');
    this.metrics.set('cycle.published', report.published);
    this.metrics.set('cycle.vetoed', vetoed);
    this.metrics.set('cycle.deferred', deferred);
    this.metrics.set('watchlist.size', this.watchlist.size);
    this.metrics.set('watchlist.maturing', this.watchlist.maturingSize);
    return report;
  }

  private row(
    mint: string,
    fr: NonNullable<ReturnType<typeof computeFeatures>>,
    safety: TokenSafety,
    vetoReason: string | null,
    extra: string[],
  ): CandidateRow {
    const { candidate } = buildCandidate({
      mint,
      features: fr.features,
      meta: fr.meta,
      safety,
      extraReasons: [...extra, ...(fr.meta.socialSuppressed ? ['social_ignored_without_onchain_confirmation'] : [])],
      ttlMs: this.cfg.candidateTtlMs,
      scoring: this.cfg.scoring,
    });
    return { candidate, vetoReason };
  }

  private enqueueNarrative(mint: string, name: string, symbol: string): void {
    const c = this.opts.classifier;
    if (!c?.enabled) return;
    const profile = this.recent.latest(mint, SignalKinds.tokenProfile) ?? this.recent.latest(mint, SignalKinds.boost);
    const description = typeof profile?.payload.description === 'string' ? profile.payload.description : '';
    const posts = this.recent
      .get(mint)
      .filter((e) => e.kind === SignalKinds.post && typeof e.payload.text === 'string')
      .slice(-8)
      .map((e) => e.payload.text as string);
    if (!description && posts.length === 0) return;
    c.enqueue({ mint, name, symbol, description, posts });
  }
}

async function runLimited<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  return out;
}

// ---------- Factory ----------

export interface ScoutConfig {
  dexscreenerBaseUrl: string;
  heliusWsUrl: string | null;
  /** HTTPS Helius RPC URL for holder counts (DAS). Null disables holder snapshots. */
  heliusRpcUrl: string | null;
  streamPrograms: string[] | null;
  lunarcrushApiKey: string | null;
  xBearerToken: string | null;
  xCuratedUserIds: string[];
  xMaxReadsPerHour: number;
  narrative: NarrativeConfig;
  creatorBlocklistPath: string;
  watchlistSize: number;
  cycle: Partial<ScoutCycleConfig>;
}

/** Reads Scout settings from environment variables (names match .env.example). */
export function scoutConfigFromEnv(env: Record<string, string | undefined> = process.env): ScoutConfig {
  const s = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : null;
  };
  const n = (k: string, d: number) => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v >= 0 ? v : d;
  };
  const rpc = s('SOLANA_RPC_URL');
  let rpcIsHelius: boolean;
  try {
    rpcIsHelius = !!rpc && new URL(rpc).protocol === 'https:' && /(^|\.)helius-rpc\.com$/i.test(new URL(rpc).hostname);
  } catch {
    rpcIsHelius = false;
  }
  return {
    dexscreenerBaseUrl: s('DEXSCREENER_BASE_URL') ?? 'https://api.dexscreener.com',
    heliusWsUrl: s('HELIUS_WS_URL'),
    heliusRpcUrl: s('HELIUS_RPC_URL') ?? (rpcIsHelius ? rpc : null),
    streamPrograms:
      s('SCOUT_STREAM_PROGRAMS')
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean) ?? null,
    lunarcrushApiKey: s('LUNARCRUSH_API_KEY'),
    xBearerToken: s('X_BEARER_TOKEN'),
    xCuratedUserIds: (s('X_CURATED_USER_IDS') ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    xMaxReadsPerHour: n('X_MAX_READS_PER_HOUR', 200),
    narrative: {
      apiUrl: s('NARRATIVE_API_URL') ?? undefined,
      apiKey: s('NARRATIVE_API_KEY') ?? undefined,
      model: s('NARRATIVE_MODEL') ?? undefined,
      maxCallsPerHour: n('NARRATIVE_MAX_CALLS_PER_HOUR', 120),
    },
    creatorBlocklistPath: s('CREATOR_BLOCKLIST_PATH') ?? resolve(process.cwd(), 'data/creator-blocklist.json'),
    watchlistSize: n('SCOUT_WATCHLIST_SIZE', 300),
    cycle: {},
  };
}

export interface ScoutDeps {
  config: ScoutConfig;
  db: Queryable;
  /** Solana Connection (SOLANA_RPC_URL) or any object with the same two methods. */
  connection: SafetyRpc;
  preset: () => Preset;
  mode?: () => TradingMode;
  sellQuoter?: SellQuoter;
  clock?: Clock;
  logger?: Logger;
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  holderProvider?: HolderCountProvider;
  /** Overrides for tests. */
  store?: CandidateStore;
  persist?: ScoutOptions['persist'];
  narrativeStore?: NarrativeStore;
}

export interface ScoutBundle {
  scout: Scout;
  /** Read side for the Trader (`CandidateSource`). */
  candidateSource: CandidateSource;
  /** Full checker with sell simulation, for the Risk Officer's independent re-check. */
  safetyChecker: OnChainSafetyChecker;
  narrative: NarrativeClassifier;
  metrics: ScoutMetrics;
}

/** Builds the Scout and its collectors from config. Optional sources stay disabled without credentials. */
export async function createScout(deps: ScoutDeps): Promise<ScoutBundle> {
  const cfg = deps.config;
  const logger = deps.logger ?? noopLogger;
  const metrics = new ScoutMetrics();
  const clock = deps.clock ?? systemClock;
  const now = () => clock.now();
  const httpFor = (secrets: (string | null | undefined)[]) =>
    new HttpClient({ fetch: deps.fetch, secrets: secrets.filter((s): s is string => !!s) });

  let blocklist: CreatorBlocklist;
  try {
    blocklist = await CreatorBlocklist.fromFile(cfg.creatorBlocklistPath);
  } catch (e) {
    // A missing file means an empty list; a malformed file is a configuration error.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
      logger.warn({}, 'creator blocklist file not found; using an empty list');
      blocklist = new CreatorBlocklist();
    } else throw e;
  }

  const persist = deps.persist ?? new PgSignalSink(deps.db, { logger, metrics });
  const store = deps.store ?? new PgCandidateStore(deps.db);
  const narrativeStore = deps.narrativeStore ?? new PgNarrativeStore(deps.db);
  const narrative = createNarrativeClassifier({
    config: cfg.narrative,
    store: narrativeStore,
    http: new HttpClient({
      fetch: deps.fetch,
      timeoutMs: 20_000,
      maxRetries: 1,
      secrets: cfg.narrative.apiKey ? [cfg.narrative.apiKey] : [],
    }),
    now,
    logger,
    metrics,
  });

  // The recent-signal store backs market facts, so the checker is created after the Scout.
  let scoutRef: Scout | null = null;
  const safetyChecker = new OnChainSafetyChecker({
    rpc: deps.connection,
    market: { market: (m) => scoutRef?.recent.market(m) ?? null },
    creatorHints: { creators: (m) => scoutRef?.recent.creators(m) ?? [] },
    blocklist,
    sellQuoter: deps.sellQuoter,
    now,
    metrics,
  });

  const scout = new Scout({
    persist,
    store,
    safety: safetyChecker,
    preset: deps.preset,
    mode: deps.mode,
    narrativeStore,
    classifier: narrative,
    clock,
    logger,
    metrics,
    config: cfg.cycle,
    watchlistSize: cfg.watchlistSize,
  });
  scoutRef = scout;

  scout.addCollector(
    new DexScreenerCollector({
      sink: scout.sink,
      watched: () => scout.watchedMints(),
      baseUrl: cfg.dexscreenerBaseUrl,
      http: httpFor([]),
      logger,
      metrics,
      now,
    }),
  );
  if (cfg.heliusWsUrl) {
    scout.addCollector(
      new HeliusStreamCollector({
        sink: scout.sink,
        url: cfg.heliusWsUrl,
        programs: cfg.streamPrograms ?? undefined,
        webSocketFactory: deps.webSocketFactory,
        logger,
        metrics,
        now: () => clock.now().getTime(),
      }),
    );
  } else {
    logger.warn({}, 'HELIUS_WS_URL not set; on-chain stream disabled');
  }
  const holderProvider =
    deps.holderProvider ??
    (cfg.heliusRpcUrl ? new HeliusDasHolderCounter({ rpcUrl: cfg.heliusRpcUrl, http: httpFor([]) }) : null);
  if (holderProvider) {
    scout.addCollector(
      new HolderStatsCollector({
        sink: scout.sink,
        provider: holderProvider,
        watched: () => scout.watchedMints(),
        now,
        logger,
        metrics,
      }),
    );
  } else {
    logger.warn({}, 'no holder count provider; holder growth stays 0, so social signals cannot raise scores');
  }
  const lunar = new LunarCrushCollector({
    sink: scout.sink,
    apiKey: cfg.lunarcrushApiKey ?? undefined,
    watched: () => scout.watchedTokens(),
    http: httpFor([cfg.lunarcrushApiKey]),
    now,
    logger,
    metrics,
  });
  if (lunar.enabled) scout.addCollector(lunar);
  const x = new XCuratedCollector({
    sink: scout.sink,
    bearerToken: cfg.xBearerToken ?? undefined,
    userIds: cfg.xCuratedUserIds,
    maxReadsPerHour: cfg.xMaxReadsPerHour,
    watchedSymbols: () => scout.watchedSymbolMap(),
    http: new HttpClient({ fetch: deps.fetch, maxRetries: 1, secrets: cfg.xBearerToken ? [cfg.xBearerToken] : [] }),
    now,
    logger,
    metrics,
  });
  if (x.enabled) scout.addCollector(x);

  return { scout, candidateSource: store, safetyChecker, narrative, metrics };
}
