# Tidepool signer

The signer is the only process that ever holds the hot wallet's private key. The engine builds
unsigned transactions and asks the signer to sign them. The signer signs only when the request
carries a valid, unexpired, unused Risk Officer reservation ticket and the transaction passes a
deny-by-default policy and the per-day cap. It never broadcasts transactions, never talks to an
RPC node, and never returns or logs key material.

## Threat model

| Asset          | Threat                                                      | Control in the signer                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hot wallet key | Theft from disk, backups or repo                            | Key encrypted at rest (scrypt + AES-256-GCM), file mode 0600 enforced, keystore and state ignored by git                                                                                                     |
| Hot wallet key | Leak through logs, errors or HTTP responses                 | Only the public key is ever printed or returned; logs are JSON lines with decisions, ids and amounts only                                                                                                    |
| Pool funds     | Compromised or buggy engine asks for arbitrary transactions | Deny-by-default policy over the compiled message; only known programs and instructions; SOL may move only to tip accounts, the wallet's own wrapped SOL account (buys) or the allowlisted withdrawal address |
| Pool funds     | Runaway spending (bug or compromise with valid tickets)     | Per-transaction cap, per-ticket cap, tip cap, priority fee cap, per-UTC-day cap persisted across restarts                                                                                                    |
| Pool funds     | Ticket replay                                               | Each reservationId is signed at most once; used ids persist until 15 minutes after the ticket expires (tolerates a backward clock step); ticket lifetime is bounded                                          |
| Pool funds     | Delayed replay of a signed transaction                      | Durable nonce instructions are denied, so every signed transaction expires with its recent blockhash                                                                                                         |
| Signer API     | Network exposure                                            | Binds loopback only unless `SIGNER_ALLOW_NON_LOOPBACK=true`; Host header must be loopback (blocks DNS rebinding); bearer token compared in constant time; 64 KB body limit; strict schemas                   |

Trust boundaries: the engine is untrusted input. The ticket MAC proves that the Risk Officer
approved a reservation, but the engine process holds the same HMAC secret, so a fully compromised
engine can mint tickets. The policy and the daily cap are therefore the controls that actually
bound loss in that case, which is why they do not depend on anything the engine says beyond the
ticket's own limits.

## Creating a keystore

Run these on the machine that will run the signer. The passphrase comes from
`SIGNER_KEYSTORE_PASSPHRASE` or an interactive hidden prompt (minimum 12 characters).

```sh
# New dedicated hot wallet (prints only the public key; fund it with what you can afford to lose)
npm run keystore -w @tidepool/signer -- create

# Import an existing secret key from stdin (base58 or Solana CLI JSON array). Never pass it as an argument.
npm run keystore -w @tidepool/signer -- import < /path/to/exported-key.json

# Show the public key of an existing keystore
npm run keystore -w @tidepool/signer -- pubkey
```

The output path defaults to `SIGNER_KEYSTORE_PATH` (`./keystore/hot-wallet.keystore.json`) and can
be changed with `--out` / `--path`. The tool refuses to overwrite an existing keystore. When piping a
key on stdin, set `SIGNER_KEYSTORE_PASSPHRASE` because there is no terminal to prompt on. Delete the
plaintext export after importing.

Keystore format (JSON, version 1): `publicKey`, `kdf` (`scrypt`, N = 2^17, r = 8, p = 1, 32-byte
salt), `cipher` (`aes-256-gcm`, 12-byte IV, 16-byte tag, ciphertext). All header fields are bound as
authenticated data. A wrong passphrase and a tampered file fail with the same generic error. The
loader refuses files that grant any permission to group or other.

## Running

```sh
npm run signer            # from the repo root, or: npm run start -w @tidepool/signer
```

Configuration (environment, validated at start; the process exits on any invalid value):

| Variable                                             | Meaning                                                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIGNER_HOST`, `SIGNER_PORT`                         | Listen address, default `127.0.0.1:7071`. Non-loopback hosts need `SIGNER_ALLOW_NON_LOOPBACK=true`                                                                            |
| `SIGNER_API_TOKEN`                                   | Bearer token the engine sends (at least 32 characters, different from the ticket secret)                                                                                      |
| `RESERVATION_TICKET_SECRET`                          | HMAC secret shared with the Risk Officer (at least 32 characters)                                                                                                             |
| `SIGNER_KEYSTORE_PATH`, `SIGNER_KEYSTORE_PASSPHRASE` | Keystore file and passphrase. The passphrase is removed from `process.env` after it is read (the kernel copy in `/proc/<pid>/environ` remains; prefer the interactive prompt) |
| `SIGNER_STATE_PATH`                                  | Replay and daily spend state (JSON, mode 0600, atomic writes)                                                                                                                 |
| `SIGNER_MAX_PER_TX_LAMPORTS`                         | Cap on non-tip SOL outflow per transaction                                                                                                                                    |
| `SIGNER_MAX_PER_DAY_LAMPORTS`                        | Cap on outflow plus tips plus priority fees per UTC day                                                                                                                       |
| `SIGNER_MAX_TIP_LAMPORTS`                            | Cap on tips per transaction, and separately on the priority fee                                                                                                               |
| `SIGNER_WITHDRAW_ALLOWLIST`                          | Comma-separated wallet addresses withdrawals may go to (must be on-curve wallet addresses)                                                                                    |
| `SIGNER_TIP_ACCOUNTS`                                | Comma-separated Jito / Sender tip accounts. Copy them from the provider's documentation. Empty means tips are denied                                                          |
| `SIGNER_EXTRA_PROGRAM_IDS`                           | Optional extra program ids to allow (opaque, not parsed)                                                                                                                      |
| `SIGNER_ALLOW_TOP_LEVEL_TOKEN_TRANSFERS`             | `true` to allow top-level SPL Transfer / TransferChecked (default `false`)                                                                                                    |
| `SIGNER_MAX_TICKET_TTL_MS`                           | Longest remaining ticket lifetime accepted, default 300000                                                                                                                    |

Run the signer as its own OS user, with the keystore directory owned by that user and mode 0700.

## API

`GET /health` returns `{ "ok": true, "publicKey": "<base58>" }`.

`POST /sign` with `Authorization: Bearer <SIGNER_API_TOKEN>` and `Content-Type: application/json`:

```json
{
  "ticket": {
    "ticket": {
      "v": 1,
      "reservationId": "...",
      "intent": "buy",
      "mint": "...",
      "maxLamports": "100000000",
      "maxTipLamports": "1000000",
      "destination": null,
      "issuedAt": 0,
      "expiresAt": 0
    },
    "mac": "<64 hex>"
  },
  "transactionBase64": "<unsigned wire transaction, legacy or v0>"
}
```

Success (200):

```json
{
  "signedTransactionBase64": "...",
  "signature": "<base58>",
  "spendLamports": "100000000",
  "tipLamports": "1000000",
  "priorityFeeLamports": "200",
  "dailySpentLamports": "101000200"
}
```

Errors: 400 malformed JSON, schema violation or undecodable transaction; 401 bad token;
403 `{ "error": "ticket rejected" | "policy denied", "reasons": [...] }`; 409 ticket already used;
413 body over 64 KB; 415 wrong content type; 421 non-loopback Host header; 500 internal or state
persistence failure (no signature is returned). A denied request does not consume the ticket. A
successful response means the ticket is consumed and its amount counted toward the daily cap,
whether or not the engine later lands the transaction.

## Policy rules

Applied to the compiled message (legacy or v0). Any rule failure denies, and every failure is
reported in `reasons`.

1. The wallet is the fee payer and the only required signer; the wallet is writable.
2. Every invoked program is System, SPL Token, Token-2022, Associated Token Account, Compute
   Budget, Jupiter v6 (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`) or a configured extra id.
   Program ids that resolve through an address lookup table are denied. Withdraw transactions may
   use only System and Compute Budget.
3. System program: `Transfer` from the wallet to a tip account (any intent), to the wallet's own
   wrapped SOL associated token account (buy only, classic Token program), or to the ticket
   destination when it is on the withdraw allowlist (withdraw only). `CreateAccount` and
   `CreateAccountWithSeed` only when funded by the wallet, owned by a token program, with the seed
   derivation verified, and at most 0.01 SOL. Everything else (Assign, Allocate, nonce
   instructions, TransferWithSeed and others) is denied. Transfer endpoints that come from a lookup
   table are denied.
4. Token programs: allowed are InitializeAccount / 2 / 3 owned by the wallet, SyncNative,
   CloseAccount with the wallet as destination, InitializeImmutableOwner and Revoke. Denied are
   SetAuthority, Approve, ApproveChecked, MintTo, Burn, Freeze, extension instructions and, unless
   configured, top-level Transfer / TransferChecked.
5. Associated Token Account: Create and CreateIdempotent paid by and owned by the wallet, with the
   System program and Token or Token-2022 as the system and token program accounts (the ATA program
   funds rent for whatever size the given token program reports, so an arbitrary program there
   could take the wallet's SOL).
6. Compute budget: SetComputeUnitLimit and SetComputeUnitPrice at most once each. Priority fee
   (`ceil(price * limit / 1e6)`, using the runtime default limit when none is set) must be within
   the tip cap.
7. Amounts: non-tip outflow (transfers plus account funding) must be within the ticket's
   `maxLamports` and `SIGNER_MAX_PER_TX_LAMPORTS`; tips within the smaller of the ticket's
   `maxTipLamports` and `SIGNER_MAX_TIP_LAMPORTS`; a sell may not transfer SOL except tips.
8. Daily cap: outflow plus tips plus priority fee, summed per UTC day across restarts, must stay
   within `SIGNER_MAX_PER_DAY_LAMPORTS`.

## Residual risks

- Jupiter instructions (and any extra program) are opaque. The signer cannot verify the input
  amount, the output mint, the minimum-out or slippage bound, or tokens and SOL moved by CPI. The
  wallet is the writable fee payer, so these programs and the venues they route through receive it
  as a writable signer; anything they move is not seen by the per-transaction, per-ticket or daily
  caps. A compromised engine can buy a worthless token, accept a bad price, or route through a
  venue that debits the wallet directly. Swap quality and balance changes depend on the engine's
  quote checks and simulation, and the real loss bound is the wallet balance.
- The ticket's `mint` field is not enforced, for the same reason.
- Rent paid inside the Associated Token Account program by CPI (about 0.002 SOL per account) and
  network base fees are not counted toward caps.
- The ticket HMAC secret lives in the engine. Tickets prove intent from the Risk Officer only while
  the engine is intact; the caps above are the backstop.
- Anyone who can write the state file can reset the daily cap, and anyone who can read process
  memory can read the key. Run the signer under its own OS user on a host without public SSH.
- The signer does not simulate transactions and cannot see the final balance changes.
- The daily total never moves back to an earlier UTC day. If the clock was set ahead by days and
  then corrected, the signer keeps booking spend on the later day and denies once the cap is used,
  until an operator fixes the clock and the state file. A clock set forward still starts a new day.
- Two signer processes must never share one state file: each keeps its own in-memory copy and the
  last writer wins, which would allow replays and double the daily cap.
- Withdrawals count toward the per-transaction and daily caps, so moving the whole pool out may
  take several transactions across days unless the caps are raised.
