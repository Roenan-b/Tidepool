# Tidepool

A Solana meme coin trading system with three cooperating agents behind one Start button, built for controls first and returns second. It runs in **paper mode by default**; live trading is impossible until a config flag, an owner confirmation and a separate signer are all in place.

| Agent | Job | Can it spend? |
| --- | --- | --- |
| **Scout** | Watches new pools, trending pairs and social chatter, filters unsafe tokens, ranks candidates with an expiry | No |
| **Trader** | Takes top candidates, sizes entries, builds swaps, manages take-profit, stop-loss and time-stop exits with deterministic rules | Only inside a reservation the Risk Officer approved |
| **Risk Officer** | Owns the money ledger, approves or vetoes each trade, enforces limits and the daily loss limit, runs the kill switch, reconciles the ledger against the chain | No, but it can halt and force exits |

## Contents

1. [Architecture](#architecture)
2. [Quick start (paper mode)](#quick-start-paper-mode)
3. [Configuration](#configuration)
4. [Using the dashboard](#using-the-dashboard)
5. [Backtesting](#backtesting)
6. [Tests](#tests)
7. [Going live: checklist](#going-live-checklist)
8. [Security model](#security-model)
9. [Known limitations](#known-limitations)

## Architecture

```
 DEX Screener ─┐
 Helius stream ─┼─> Scout ──(ranked candidates, Postgres)──> Trader ──reserve()──> Risk Officer ──> Postgres ledger
 LunarCrush ───┤      │                                         │                     │  (sole writer, hash-chained audit log)
 Curated X ────┘      └─ narrative classifier (async, cached)   │                     └─ signed reservation ticket
                                                                 ▼
                                                     Broker (paper: cost-model fills / live: Jupiter + signer)
                                                                 │
                                                       Signer process (holds the key, deny-by-default policy)

 Dashboard (Next.js, macOS-style) ──server side only──> Engine control API (127.0.0.1, bearer token)
```

| Path | What it is |
| --- | --- |
| `packages/core` | Shared types, presets, cost model, reservation tickets, API contract |
| `apps/engine` | One process running Scout, Trader and Risk Officer, plus the control API, backtest harness and alerts |
| `apps/signer` | Separate process; the only component that ever holds the wallet key |
| `apps/dashboard` | Jake's one-button view (`/`) and the operations view (`/ops`) |
| `db/migrations` | Postgres schema |

Design rules the code enforces:

- **Deterministic code decides every entry, exit, size and veto.** The optional narrative classifier only enriches scores asynchronously; the Trader never waits on it, and its output is a schema-validated label and a 0 to 1 score.
- **Social data confirms, never triggers.** A token must first surface on-chain or on DEX Screener, and social points only count once on-chain activity (holder growth, real volume) confirms it. Paid boosts count against a token.
- **No spend without a reservation.** The Risk Officer locks each amount in one database transaction under a row lock, so concurrent requests can never over-allocate. In live mode it issues an HMAC-signed ticket and the signer refuses any transaction without a valid, unused one.
- **Exits are never blocked.** Halts stop new entries only. The kill switch halts everything and sells every open position.
- **Paper fills are cost-realistic.** They use live quotes plus venue fees, slippage, tips, base fees and a failure rate, not quoted prices.

## Quick start (paper mode)

Prerequisites: Node.js 20.11 or newer, npm 10, Docker (for Postgres) or a local Postgres 16.

```bash
npm install
cp .env.example .env
# Generate the three shared secrets and paste them into .env:
openssl rand -hex 32   # ENGINE_API_TOKEN
openssl rand -hex 32   # RESERVATION_TICKET_SECRET
openssl rand -hex 32   # SIGNER_API_TOKEN
openssl rand -base64 32   # AUTH_ENCRYPTION_KEY

npm run db:up          # Postgres on 127.0.0.1:5432
npm run build -w @tidepool/core
npm run db:migrate
```

Create the dashboard users (passwords are read from stdin, never from the command line):

```bash
npm run create-user -w @tidepool/dashboard -- create --username jake --role owner
npm run create-user -w @tidepool/dashboard -- create --username roe --role operator
```

Run the engine and the dashboard in two terminals:

```bash
npm run engine
npm run dashboard      # http://127.0.0.1:3000
```

Sign in, enroll an authenticator app on the security page (required before anything else is available), then press **Start**. The first Start funds the paper pool with `PAPER_STARTING_SOL`.

Enroll each account's authenticator yourself right after creating it: until two-factor is set up, anyone with the password could enroll their own device. Turning two-factor on ends every other session for that account.

To preview the interface without an engine or database:

```bash
cd apps/dashboard
DEMO_MODE=true npx next build && DEMO_MODE=true npx next start -H 127.0.0.1 -p 3100
```

Demo mode serves fixture data, disables every action and refuses to run when an engine token or database is configured.

## Configuration

Every variable is documented in [`.env.example`](.env.example). The ones that matter first:

| Variable | Purpose |
| --- | --- |
| `LIVE_TRADING_ENABLED` | Must be exactly `true` for live mode to be possible at all. Default `false`. |
| `PAPER_STARTING_SOL` | Starting balance of the paper pool |
| `SOLANA_RPC_URL`, `HELIUS_*` | Chain reads. A Helius RPC URL also enables holder-count growth, which social signals need before they can raise a score. |
| `JUPITER_BASE_URL`, `JUPITER_API_KEY` | Quotes for paper fills and swaps for live trading |
| `LUNARCRUSH_API_KEY`, `X_BEARER_TOKEN`, `X_CURATED_USER_IDS` | Optional social sources. X reads are pay per read and capped by `X_MAX_READS_PER_HOUR`. |
| `NARRATIVE_API_URL`, `NARRATIVE_API_KEY`, `NARRATIVE_MODEL` | Optional narrative classifier (any endpoint that speaks the common chat completions format) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alerts: halts, kill switch, reconciliation errors, daily summary |

Risk presets (Conservative, Balanced, Aggressive) live in `packages/core/src/presets.ts`. Jake picks a preset; raw parameters are not editable from his screen.

## Using the dashboard

**Jake's view (`/`)**: Start and Pause, preset picker, a permanent PAPER or LIVE badge, today's net P&L after all fees against the daily loss limit, the pool balance, deposit address with QR code, withdrawals (only to the allowlisted address; changing it takes 24 hours), and **Stop and sell everything** behind a confirmation sheet. Switching to LIVE requires typing a confirmation sentence and is disabled unless the engine allows it.

**Operations view (`/ops`, operator only)**: engine state and halt clearing, the live signal feed, candidate scores with reasons and vetoes, open and closed positions, latency percentiles, landing rate, RPC health, data freshness, reconciliation status, audit chain validity, and the full decision log.

Both views require a password plus a TOTP code. The interface follows the system light or dark setting and has a manual toggle.

## Backtesting

```bash
# Synthetic demonstration data (labelled synthetic in every output)
npm run backtest -- --synthetic-demo --preset balanced

# Recorded data
npm run backtest -- --signals data/recordings/signals.jsonl --prices data/recordings/prices.jsonl --preset balanced
npm run backtest -- --signals ... --prices ... --walk-forward --split 2026-11-01
```

Reports (JSON and Markdown) go to `data/reports/`: trades, win rate, net per trade after costs, max drawdown, daily P&L, a cost breakdown, loss-limit days, and a comparison with holding SOL when a SOL price series is supplied. Walk-forward mode tunes on the early window and reports only on the unseen later window.

## Tests

The suite needs a Postgres test database (`TEST_DATABASE_URL`, created automatically by `docker compose`):

```bash
npm run build -w @tidepool/core
npm test
npm run typecheck
```

Coverage highlights: 1,000 concurrent reservations never over-allocate; every limit and filter vetoes at its boundary; daily loss and drawdown halts; exact lamport accounting; audit chain tamper detection; signer policy against malicious transactions; replay and daily cap enforcement in the signer; TOTP against RFC 6238 vectors; prompt-injection fixtures for the narrative classifier; backtest look-ahead protection.

## Going live: checklist

Nothing below is automated on purpose. Do these in order and do not skip the paper gate.

1. **Paper gate:** at least 500 paper trades over at least 14 days with positive net P&L after all costs, and results that hold on data not used for tuning.
2. **Confirm the external APIs.** The Jupiter swap paths and fields, the Sender and Jito submission formats, and the DEX Screener, LunarCrush and X response shapes were written from documentation and have not been exercised against live endpoints. Read `apps/engine/src/trader/jupiter.ts` and `liveBroker.ts` against current provider docs.
3. **Create the hot wallet** on the server that runs the signer: `npm run keystore -w @tidepool/signer -- create`. It prints only the public key. Fund it only with an amount Jake can lose entirely.
4. **Set signer policy:** `SIGNER_WITHDRAW_ALLOWLIST` (Jake's own wallet), `SIGNER_TIP_ACCOUNTS` if using Sender or Jito, and per-transaction and daily caps sized to the micro pool. Live position sizes are capped below `SIGNER_MAX_PER_TX_LAMPORTS`, and the same caps also apply to withdrawals.
5. **Run the signer** (`npm run signer`) as a separate OS user, on loopback only, with the keystore and state file readable only by that user.
6. Set `LIVE_TRADING_ENABLED=true`, restart the engine, and switch to LIVE from Jake's view with the confirmation sentence.
7. Compare every live fill with its paper twin for at least 7 days with zero reconciliation errors before raising the pool.

## Security model

- **Custody:** the key exists only in the signer, encrypted at rest (scrypt plus AES-256-GCM). The signer signs only transactions with a valid Risk Officer ticket, only from allowed programs, only to the wallet's own accounts, tip accounts or the allowlisted withdrawal address, within per-transaction, per-day and tip caps.
- **Dashboard:** password plus mandatory TOTP, hashed session tokens, SameSite=Strict cookies, Origin checks on every change, a nonce-based content security policy, and server-side role checks. The browser never sees the engine token. The dashboard cannot move funds anywhere except the allowlisted withdrawal address.
- **Audit:** every decision is an append-only, hash-chained row; the database rejects updates and deletes, and the ops view shows whether the chain verifies.
- **Network:** the engine API and signer bind to loopback only. Put the dashboard behind TLS and a VPN or tunnel; do not expose SSH publicly.

## Known limitations

- **Router instructions are opaque to the signer.** It cannot decode the Jupiter swap instruction, and the wallet is a writable signer for it, so a compromised engine that also holds the ticket secret could route a swap badly. The caps bound SOL leaving through top-level transfers, not value lost inside a swap. A stronger control (a simulation-based balance check in the signer, or a separate low-balance fee payer) is recommended before scaling past a micro pool.
- **Swap instruction contents are not inspected.** The broker validates every Jupiter quote (mints, amounts, minimum out, route) and only accepts the expected swap program, but nothing parses the swap instruction itself before signing.
- **Live sells do not pre-check the token balance,** and token accounts are not closed after a sell, so about 0.002 SOL of rent stays locked per traded token.
- **Live deposits must be booked.** Reconciliation halts on any unexplained balance change, including a deposit, until it is booked. A deposit watcher is not built yet.
- **Passkeys are not implemented;** TOTP is the second factor. Money actions (live mode, withdrawal address) do not ask for a fresh code, and sessions have a fixed 12 hour lifetime with no idle timeout.
- **Unknown live outcomes are held, not retried.** A buy or sell whose result is unknown blocks that token and raises a critical alert; the operator resolves it against the chain. Reconciliation then halts on any balance difference.
- **Backtests assume zero latency,** so their results are optimistic.
- **Helius log parsing is best effort.** pump.fun create and complete events resolve to mints; other new-pool events are recorded by signature only.
- **Latency and information edge:** this system will usually be later to a move than professional firms and launch insiders. Its aim is to lose small when wrong and never more than the agreed limits.
- **Returns:** a fixed $200 a day is not a realistic target for a small pool after costs. It appears on the dashboard only as a reference line.

## License

Private. All rights reserved.
