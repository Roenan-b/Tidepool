# Changelog

All notable changes to this project are documented in this file. Entries are generated from [Conventional Commits](https://www.conventionalcommits.org) by Release Please, and versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 (2026-11-22)

### Features

- Scout with DEX Screener, Helius stream, LunarCrush and curated X collectors, token safety filters, deterministic scoring with an optional narrative classifier, and a holding tier for new launches.
- Trader with deterministic entries and exits, a cost-realistic paper broker, and a live broker with Jupiter quote validation and conservative handling of unknown outcomes.
- Risk Officer with a Postgres reservation ledger, daily loss and drawdown halts, kill switch, reconciliation, timelocked withdrawal address and a hash-chained audit log.
- Separate signer process with an encrypted keystore, deny-by-default transaction policy, ticket replay protection and daily caps.
- macOS-style dashboard with password plus TOTP sign-in, an owner view and an operations view.
- Backtest harness with walk-forward evaluation.
