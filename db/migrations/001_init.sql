-- Tidepool schema. The Risk Officer (engine/src/risk) is the only writer to pool_balances,
-- reservations, positions and ledger_entries. Other modules write signals/candidates/orders via
-- their own repositories, and the audit log is append-only (enforced by trigger).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per trading mode, so paper and live books never mix.
CREATE TABLE pool_state (
  mode text PRIMARY KEY CHECK (mode IN ('paper','live')),
  engine_state text NOT NULL DEFAULT 'stopped' CHECK (engine_state IN ('stopped','running','paused','halted')),
  halt_reason text NULL,
  preset text NOT NULL DEFAULT 'balanced' CHECK (preset IN ('conservative','balanced','aggressive')),
  cash_lamports bigint NOT NULL DEFAULT 0 CHECK (cash_lamports >= 0),
  peak_equity_lamports bigint NOT NULL DEFAULT 0,
  sod_equity_lamports bigint NOT NULL DEFAULT 0,      -- start-of-day equity (UTC)
  sod_date date NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Which mode is active, plus wallet settings that apply to both modes.
CREATE TABLE settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  active_mode text NOT NULL DEFAULT 'paper' CHECK (active_mode IN ('paper','live')),
  deposit_address text NULL,
  withdraw_address text NULL,
  pending_withdraw_address text NULL,
  pending_withdraw_effective_at timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO pool_state (mode) VALUES ('paper'), ('live') ON CONFLICT DO NOTHING;

CREATE TABLE sleeves (
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  name text NOT NULL,
  alloc_bps integer NOT NULL CHECK (alloc_bps BETWEEN 0 AND 10000),
  PRIMARY KEY (mode, name)
);
INSERT INTO sleeves (mode, name, alloc_bps) VALUES ('paper','momentum-v1',10000), ('live','momentum-v1',10000) ON CONFLICT DO NOTHING;

CREATE TABLE reservations (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  idempotency_key text NOT NULL,
  sleeve text NOT NULL,
  mint text NOT NULL,
  lamports bigint NOT NULL CHECK (lamports > 0),
  status text NOT NULL CHECK (status IN ('held','filled','released','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  settled_at timestamptz NULL,
  UNIQUE (mode, idempotency_key)
);
CREATE INDEX reservations_held_idx ON reservations (mode) WHERE status = 'held';

CREATE TABLE positions (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  reservation_id uuid NULL REFERENCES reservations(id),
  mint text NOT NULL,
  symbol text NOT NULL,
  strategy text NOT NULL,
  status text NOT NULL CHECK (status IN ('open','closing','closed')),
  entry_lamports bigint NOT NULL CHECK (entry_lamports > 0),
  token_amount numeric(40,0) NOT NULL CHECK (token_amount >= 0),
  entry_price_usd double precision NOT NULL,
  mark_lamports bigint NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz NULL,
  exit_lamports bigint NULL,
  exit_reason text NULL,
  realized_pnl_lamports bigint NULL,
  config_version text NOT NULL
);
CREATE INDEX positions_open_idx ON positions (mode, status) WHERE status <> 'closed';

-- Signed journal of every SOL movement on the books. Sum of entries per mode equals cash + cost basis moves.
CREATE TABLE ledger_entries (
  id bigserial PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('deposit','withdraw','buy','sell','fee','adjustment')),
  lamports bigint NOT NULL,          -- signed: + into cash, - out of cash
  ref text NULL,
  note text NULL
);

-- Orders as submitted by the Trader (one per transaction attempt).
CREATE TABLE orders (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('paper','live')),
  position_id uuid NULL REFERENCES positions(id),
  reservation_id uuid NULL REFERENCES reservations(id),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  mint text NOT NULL,
  status text NOT NULL CHECK (status IN ('built','submitted','landed','failed')),
  signature text NULL,
  lamports bigint NULL,
  token_amount numeric(40,0) NULL,
  fee_lamports bigint NULL,
  signal_at timestamptz NULL,
  submitted_at timestamptz NULL,
  landed_at timestamptz NULL,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_recent_idx ON orders (mode, created_at DESC);

-- Raw normalized events from collectors (on-chain, DEX Screener, social).
CREATE TABLE signals (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  mint text NULL,
  kind text NOT NULL,
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signals_mint_time_idx ON signals (mint, observed_at DESC);
CREATE INDEX signals_source_time_idx ON signals (source, observed_at DESC);

-- Latest ranked candidates from the Scout (one row per mint).
CREATE TABLE candidates (
  mint text PRIMARY KEY,
  symbol text NOT NULL,
  pair_address text NOT NULL,
  score double precision NOT NULL,
  price_usd double precision NOT NULL,
  features jsonb NOT NULL,
  safety jsonb NOT NULL,
  reasons jsonb NOT NULL,
  veto_reason text NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX candidates_rank_idx ON candidates (score DESC, expires_at);

-- Cached asynchronous narrative scores (never awaited by the Trader).
CREATE TABLE narrative_scores (
  mint text PRIMARY KEY,
  label text NOT NULL,
  score double precision NOT NULL CHECK (score >= 0 AND score <= 1),
  scam_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary text NOT NULL DEFAULT '',
  model text NOT NULL,
  scored_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cooldowns (
  mode text NOT NULL,
  mint text NOT NULL,
  until timestamptz NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (mode, mint)
);

CREATE TABLE reconciliation_runs (
  id bigserial PRIMARY KEY,
  mode text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  ledger_lamports bigint NOT NULL,
  chain_lamports bigint NULL,
  diff_lamports bigint NULL,
  ok boolean NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Append-only, hash-chained audit log. hash = sha256(prev_hash || canonical(event)).
CREATE TABLE audit_events (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL,
  type text NOT NULL,
  ref text NULL,
  payload jsonb NOT NULL,
  prev_hash text NOT NULL,
  hash text NOT NULL UNIQUE
);
CREATE INDEX audit_events_ref_idx ON audit_events (ref);

CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Dashboard authentication (owned by the dashboard app).
CREATE TABLE auth_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner','operator')),
  password_hash text NOT NULL,
  totp_secret_enc text NULL,          -- AES-256-GCM encrypted with AUTH_ENCRYPTION_KEY
  totp_enabled boolean NOT NULL DEFAULT false,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id_hash text PRIMARY KEY,           -- sha256 of the random session token; the token itself is never stored
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip text NULL,
  user_agent text NULL
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);
