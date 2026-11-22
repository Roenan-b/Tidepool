/** Public surface of the trader module for main.ts wiring. */
export {
  Trader,
  createTrader,
  type TraderDeps,
  type TraderOptions,
  type SellRetryOptions,
  type EntryTickResult,
  type MonitorTickResult,
} from './trader.js';
export { PaperBroker, emptyCostTotals, type PaperBrokerOptions, type PaperCostTotals } from './paperBroker.js';
export {
  LiveBroker,
  UnknownOutcomeError,
  type LiveBrokerOptions,
  type LiveConnection,
  type LandingConfig,
} from './liveBroker.js';
export {
  JupiterClient,
  JupiterError,
  JupiterQuoteSource,
  JupiterSellQuoter,
  RateLimiter,
  SOL_MINT,
  type JupiterClientOptions,
  type SellQuoter,
} from './jupiter.js';
export { HttpSignerClient, SignerError, type SignerClient, type HttpSignerClientOptions } from './signerClient.js';
export { PgOrderRepository, InMemoryOrderRepository, type Queryable } from './orders.js';
export * from './strategy.js';
export * from './types.js';
export { createRng, type Rng } from './rng.js';
