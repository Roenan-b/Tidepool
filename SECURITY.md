# Security policy

Tidepool handles trading decisions and, in live mode, a hot wallet. Security reports are taken seriously.

## Supported versions

Only the latest release on `main` receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, the affected files or components, steps to reproduce, and the impact you expect. You will get an acknowledgement, and fixes are released before details are made public.

## Scope

In scope: the engine (Scout, Trader, Risk Officer, control API), the signer, the dashboard, and the database schema.

Out of scope: third-party services the system calls (Solana RPC providers, Jupiter, DEX Screener, social data providers) and deployments that ignore the setup guidance in the README, such as exposing the engine API or signer beyond loopback.

## Using this code

This repository ships with paper trading enabled by default. Never commit keys, keystores or `.env` files. If you run it with real funds, you accept the risk of loss; read the "Going live" checklist and "Known limitations" in the README first.
