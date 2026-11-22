/**
 * Engine entry point. Wires the Scout, Trader and Risk Officer for the active trading mode,
 * starts the control API on loopback, and schedules the Risk Officer's housekeeping timers.
 *
 * Safety defaults on boot:
 *  - Paper mode unless settings.active_mode is 'live' AND LIVE_TRADING_ENABLED=true.
 *  - If the book was 'running' when the process stopped, it comes back 'paused': exits keep
 *    running, but new entries wait for the owner to press Start again.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getPreset, type PresetName, type TradingMode } from '@tidepool/core';
import { loadConfig, ConfigError, type EngineConfig } from './config.js';
import { createLogger } from './log.js';
import { createPool, runMigrations } from './db/index.js';
import { PgAuditLog } from './audit/index.js';
import { PgRiskOfficer, riskSettingsFromConfig, loadBookTotals } from './risk/index.js';
import { buildControlApi, listenControlApi, PgQueries } from './api/index.js';
import { createAlerter } from './alerts/index.js';
import { createScout, scoutConfigFromEnv } from './scout/index.js';
import {
  Trader,
  PaperBroker,
  LiveBroker,
  JupiterClient,
  JupiterQuoteSource,
  JupiterSellQuoter,
  HttpSignerClient,
  PgOrderRepository,
  type TraderAlert,
} from './trader/index.js';
import type { EngineControl, RiskOfficer } from './contracts.js';
import { withFreshSafety } from './wiring/safetyGate.js';
import { toScoutSellQuoter, SolPriceFeed, RpcHealthTracker, liveSizeCap } from './wiring/adapters.js';
import { WithdrawalExecutor, type WithdrawalChain } from './wiring/withdrawals.js';
import type pg from 'pg';

async function readActiveMode(pool: pg.Pool, cfg: EngineConfig): Promise<TradingMode> {
  const r = await pool.query<{ active_mode: TradingMode }>('SELECT active_mode FROM settings WHERE id = 1');
  const m = r.rows[0]?.active_mode ?? 'paper';
  return m === 'live' && cfg.liveTradingEnabled ? 'live' : 'paper';
}

async function readPoolState(
  pool: pg.Pool,
  mode: TradingMode,
): Promise<{ state: string; preset: PresetName; cash: bigint }> {
  const r = await pool.query<{ engine_state: string; preset: PresetName; cash_lamports: string }>(
    'SELECT engine_state, preset, cash_lamports::text FROM pool_state WHERE mode = $1',
    [mode],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`pool_state row missing for ${mode}`);
  return { state: row.engine_state, preset: row.preset, cash: BigInt(row.cash_lamports) };
}

async function fetchSignerWallet(url: string): Promise<string> {
  const res = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`signer health check failed with status ${res.status}`);
  const body = (await res.json()) as { ok?: boolean; publicKey?: string };
  if (!body.ok || typeof body.publicKey !== 'string') throw new Error('signer health response malformed');
  return new PublicKey(body.publicKey).toBase58();
}

async function main(): Promise<void> {
  let cfg: EngineConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const log = createLogger({ level: cfg.logLevel, name: 'engine' });
  const pool = createPool(cfg.databaseUrl, { logger: log });
  await runMigrations(pool);

  const audit = new PgAuditLog({ pool });
  const alerter = createAlerter(cfg, log);
  const connection = new Connection(cfg.solana.rpcUrl, 'confirmed');
  const rpcHealth = new RpcHealthTracker();
  const jupiter = new JupiterClient({
    baseUrl: cfg.jupiter.baseUrl,
    ...(cfg.jupiter.apiKey ? { apiKey: cfg.jupiter.apiKey } : {}),
  });
  const solPrice = new SolPriceFeed(jupiter, {
    onError: (e) => log.warn({ err: String(e) }, 'SOL price refresh failed'),
  });
  solPrice.start();
  const solUsd = () => solPrice.get();

  const riskSettings = riskSettingsFromConfig(cfg);
  const officers: Partial<Record<TradingMode, PgRiskOfficer>> = {
    paper: new PgRiskOfficer({ pool, audit, mode: 'paper', solUsd, config: riskSettings, alerter, logger: log }),
  };
  let walletPublicKey: string | null = null;
  if (cfg.liveTradingEnabled) {
    if (!cfg.signer || !cfg.ticketSecret) throw new Error('live trading enabled without signer configuration');
    officers.live = new PgRiskOfficer({
      pool,
      audit,
      mode: 'live',
      solUsd,
      ticketSecret: cfg.ticketSecret,
      config: riskSettings,
      alerter,
      logger: log,
    });
    walletPublicKey = await fetchSignerWallet(cfg.signer.url);
    await officers.live.setDepositAddress(walletPublicKey);
    log.info({ wallet: walletPublicKey }, 'live trading is permitted by config; signer reachable');
  }
  const officerFor = (m: TradingMode): PgRiskOfficer => {
    const o = officers[m];
    if (!o) throw new Error(`no risk officer for ${m} mode (live trading disabled by config)`);
    return o;
  };

  let activeMode = await readActiveMode(pool, cfg);
  let activePreset: PresetName = (await readPoolState(pool, activeMode)).preset;

  // ---------- Scout ----------
  const sellQuoter = new JupiterSellQuoter(jupiter);
  const scoutBundle = await createScout({
    config: scoutConfigFromEnv(process.env),
    db: pool,
    connection,
    preset: () => getPreset(activePreset),
    mode: () => activeMode,
    sellQuoter: toScoutSellQuoter(sellQuoter),
    logger: log,
  });

  // ---------- Trader ----------
  const orders = new PgOrderRepository(pool);
  const costReference = new PaperBroker({ quotes: new JupiterQuoteSource(jupiter) });

  const equityOf = async (mode: TradingMode): Promise<bigint> => {
    const [ps, book] = await Promise.all([readPoolState(pool, mode), loadBookTotals(pool, mode)]);
    return ps.cash + book.inPositionsLamports;
  };

  const traderAlert = (a: TraderAlert) => {
    log[a.level === 'critical' ? 'error' : 'warn']({ code: a.code }, a.message);
    void alerter.notify({
      kind: 'accounting_warning',
      severity: a.level,
      mode: activeMode,
      title: `Trader: ${a.code}`,
      body: a.message,
    });
  };

  function buildTrader(mode: TradingMode): Trader {
    const officer: RiskOfficer = withFreshSafety(officerFor(mode), scoutBundle.safetyChecker, (mint, err) =>
      log.warn({ mint, err: String(err) }, 'fresh safety check failed; reservation vetoed'),
    );
    let broker;
    if (mode === 'paper') {
      broker = new PaperBroker({ quotes: new JupiterQuoteSource(jupiter) });
    } else {
      if (!cfg.liveTradingEnabled || !cfg.signer || !walletPublicKey)
        throw new Error('live broker requested while live trading is disabled');
      const tipAccount = (process.env.SIGNER_TIP_ACCOUNTS ?? '')
        .split(',')
        .map((s) => s.trim())
        .find(Boolean);
      const method = cfg.solana.landingMethod;
      const landingUrl =
        method === 'sender' ? cfg.solana.senderUrl : method === 'jito' ? cfg.solana.jitoBlockEngineUrl : null;
      if (method !== 'rpc' && (!landingUrl || !tipAccount))
        throw new Error(`LANDING_METHOD=${method} needs its URL and SIGNER_TIP_ACCOUNTS`);
      broker = new LiveBroker({
        liveTradingEnabled: true,
        connection,
        jupiter,
        signer: new HttpSignerClient({ url: cfg.signer.url, token: cfg.signer.apiToken }),
        walletPublicKey,
        landing: method === 'rpc' ? { method: 'rpc' } : { method, url: landingUrl!, tipAccount: tipAccount! },
      });
    }
    return new Trader(
      {
        risk: officer,
        broker,
        candidates: scoutBundle.candidateSource,
        orders,
        equityLamports: () => equityOf(mode),
        solUsd,
        costModelFor: (mint) => costReference.costModelFor(mint),
        audit,
        logger: log,
        alert: traderAlert,
        onStateChange: (state, info) =>
          log.info({ mode, state, preset: info.preset, reason: info.reason }, 'trader state'),
      },
      {
        // The signer refuses a buy whose SOL outflow exceeds its per-transaction cap, so live sizing
        // stays under that cap with room for the tip, priority fee and token account rent.
        paramOverrides:
          mode === 'live' && cfg.signer
            ? { maxPositionLamports: liveSizeCap(cfg.signer.maxPerTxLamports, cfg.signer.maxTipLamports) }
            : {},
      },
    );
  }

  let trader = buildTrader(activeMode);

  /** Runs exits (and only exits) for whatever positions exist, without enabling entries. */
  async function startMonitoringOnly(t: Trader, preset: PresetName): Promise<void> {
    await t.start(preset);
    await t.pause();
  }

  const control: EngineControl = {
    async start(preset) {
      activePreset = preset;
      await trader.start(preset);
    },
    async pause() {
      await trader.pause();
    },
    async killSwitch() {
      return trader.killSwitch();
    },
  };

  // Boot: never resume entries automatically.
  {
    const officer = officerFor(activeMode);
    const ps = await readPoolState(pool, activeMode);
    if (ps.state === 'running') {
      await officer.pause('system');
      log.warn({ mode: activeMode }, 'engine restarted while running; book paused until the owner presses Start');
    }
    await startMonitoringOnly(trader, ps.preset);
  }

  // ---------- Control API ----------
  const queries = new PgQueries({
    pool,
    audit,
    solUsd,
    liveTradingAllowed: cfg.liveTradingEnabled,
    stretchTargetUsd: cfg.stretchTargetUsd,
    rpcHealth: () => rpcHealth.snapshot(),
    knownSignalSources: ['dexscreener', 'helius', 'lunarcrush', 'x'],
  });
  // Live withdrawals: sign through the signer, submit, confirm, then book against the hold.
  let withdrawalExecutor: WithdrawalExecutor | null = null;
  if (officers.live && cfg.signer && walletPublicKey) {
    const liveOfficer = officers.live;
    const chain: WithdrawalChain = {
      latestBlockhash: () => connection.getLatestBlockhash('confirmed'),
      sendRaw: (raw) => connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }),
      confirm: async (signature, blockhash, lastValidBlockHeight) => {
        const r = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
        if (r.value.err) throw new Error(`transaction failed on chain: ${JSON.stringify(r.value.err).slice(0, 120)}`);
        return true;
      },
      feeLamports: async (signature) => {
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        return tx?.meta ? BigInt(tx.meta.fee) : null;
      },
    };
    withdrawalExecutor = new WithdrawalExecutor({
      wallet: new PublicKey(walletPublicKey),
      signer: new HttpSignerClient({ url: cfg.signer.url, token: cfg.signer.apiToken }),
      chain,
      record: (id, sent, fee, sig) => liveOfficer.recordWithdrawal(id, sent, fee, sig),
      onOutcome: (job, outcome) => {
        const ok = outcome.status === 'booked';
        void audit
          .append({
            actor: 'system',
            type: ok ? 'withdrawal_sent' : 'withdrawal_not_completed',
            ref: job.withdrawalId,
            payload: {
              ...outcome,
              feeLamports: 'feeLamports' in outcome ? outcome.feeLamports.toString() : undefined,
              lamports: job.lamports.toString(),
              destination: job.destination,
            },
          })
          .catch((err: unknown) => log.error({ err: String(err) }, 'failed to audit withdrawal outcome'));
        void alerter.notify({
          kind: 'withdrawal',
          severity: ok ? 'info' : 'warning',
          mode: 'live',
          title: ok ? 'Withdrawal sent' : `Withdrawal ${outcome.status.replace('_', ' ')}`,
          body: ok
            ? `${job.lamports} lamports to ${job.destination}.`
            : `${job.lamports} lamports to ${job.destination} was not booked. The hold expires on its own; reconciliation will flag a transfer that landed late.`,
        });
      },
    });
  }

  const api = buildControlApi({
    riskOfficer: (m) => officerFor(m),
    submitWithdrawal: withdrawalExecutor
      ? (job) => {
          void withdrawalExecutor
            .execute(job)
            .catch((err: unknown) => log.error({ err: String(err) }, 'withdrawal execution crashed'));
        }
      : undefined,
    control,
    queries,
    config: cfg,
    audit,
    logger: log,
    onModeChange: async (mode) => {
      await trader.stop();
      activeMode = mode;
      trader = buildTrader(mode);
      const ps = await readPoolState(pool, mode);
      activePreset = ps.preset;
      await startMonitoringOnly(trader, ps.preset);
      log.info({ mode }, 'trading mode switched; entries wait for Start');
    },
  });
  await listenControlApi(api, cfg);
  scoutBundle.scout.start();

  // ---------- Housekeeping timers ----------
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let busy = false;
    const t = setInterval(() => {
      if (busy) return;
      busy = true;
      fn()
        .catch((err: unknown) => log.error({ task: name, err: String(err) }, 'housekeeping task failed'))
        .finally(() => {
          busy = false;
        });
    }, ms);
    timers.push(t);
  };

  every(10_000, 'expire-reservations', async () => {
    for (const o of Object.values(officers)) await o?.expireStaleReservations();
  });
  every(cfg.risk.reconcileIntervalSeconds * 1000, 'reconcile', async () => {
    const officer = officerFor(activeMode);
    if (activeMode === 'live' && walletPublicKey) {
      const wallet = new PublicKey(walletPublicKey);
      await officer.reconcile(async () => {
        try {
          const lamports = BigInt(await connection.getBalance(wallet, 'confirmed'));
          rpcHealth.record(true);
          return lamports;
        } catch (err) {
          rpcHealth.record(false);
          throw err;
        }
      });
    } else {
      await officer.reconcile();
      try {
        await connection.getSlot('confirmed');
        rpcHealth.record(true);
      } catch {
        rpcHealth.record(false);
      }
    }
  });
  every(60_000, 'promote-withdraw-address', async () => {
    for (const o of Object.values(officers)) await o?.promotePendingWithdrawAddress();
  });
  every(5 * 60_000, 'audit-verify', () => queries.refreshAuditValidity());

  let lastSummaryDate = new Date().toISOString().slice(0, 10);
  every(60_000, 'daily-summary', async () => {
    const today = new Date().toISOString().slice(0, 10);
    if (today === lastSummaryDate) return;
    const previous = lastSummaryDate;
    lastSummaryDate = today;
    await alerter.dailySummary(await officerFor(activeMode).dailySummary(previous));
  });

  // Circuit breakers: stale market data and unhealthy RPC halt new entries (exits continue).
  every(15_000, 'circuit-breakers', async () => {
    const officer = officerFor(activeMode);
    const ps = await readPoolState(pool, activeMode);
    if (ps.state !== 'running') return;
    const fresh = scoutBundle.scout.freshness();
    const lastCycle = fresh.lastCycleAt?.getTime() ?? 0;
    if (Date.now() - lastCycle > 120_000) {
      await officer.halt('stale_data', 'scout has not completed a cycle in over two minutes');
      return;
    }
    const rpc = rpcHealth.snapshot();
    if (rpc.lastOkAt !== null && !rpc.healthy)
      await officer.halt('rpc_errors', `rpc error rate ${(rpc.errorRate * 100).toFixed(0)}%`);
  });

  log.info(
    { mode: activeMode, api: `${cfg.api.host}:${cfg.api.port}`, liveTradingEnabled: cfg.liveTradingEnabled },
    'engine started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');
    for (const t of timers) clearInterval(t);
    solPrice.stop();
    try {
      await api.close();
    } catch {
      /* already closed */
    }
    try {
      await trader.stop();
    } catch (err) {
      log.error({ err: String(err) }, 'trader stop failed');
    }
    try {
      await scoutBundle.scout.stop();
    } catch (err) {
      log.error({ err: String(err) }, 'scout stop failed');
    }
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  process.stderr.write(`engine failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
