-- Server-owned identities. An anonymous user is the ownership anchor for all
-- usage and generation rows; a recoverable identity can later be linked to the
-- same users.id without rewriting ownership.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  account_type TEXT NOT NULL DEFAULT 'anonymous',
  total_completed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  disabled_at TIMESTAMPTZ,
  CONSTRAINT users_id_format CHECK (id ~ '^usr_[0-9a-f]{32}$'),
  CONSTRAINT users_account_type_valid CHECK (account_type IN ('anonymous')),
  CONSTRAINT users_total_completed_nonnegative CHECK (total_completed >= 0)
);

-- Bearer credentials. Only the SHA-256 hash of each token is stored.
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT auth_tokens_id_format CHECK (id ~ '^tok_[0-9a-f]{32}$'),
  CONSTRAINT auth_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT auth_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX auth_tokens_user_id_idx ON auth_tokens (user_id);

-- Free Basic accounting per user and UTC day.
-- free_pending counts reserved-but-unfinished starts; free_consumed counts successes.
CREATE TABLE daily_usage (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  usage_day DATE NOT NULL,
  free_consumed INTEGER NOT NULL DEFAULT 0,
  free_pending INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, usage_day),
  CONSTRAINT daily_usage_consumed_nonnegative CHECK (free_consumed >= 0),
  CONSTRAINT daily_usage_pending_nonnegative CHECK (free_pending >= 0),
  CONSTRAINT daily_usage_free_limit CHECK (free_consumed + free_pending <= 3)
);

CREATE TABLE generations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  idempotency_key TEXT,
  request_hash TEXT NOT NULL,
  client_session_id TEXT,
  kind TEXT NOT NULL,
  source_generation_id TEXT REFERENCES generations (id) ON DELETE SET NULL,
  mode TEXT NOT NULL,
  generation_mode TEXT NOT NULL,
  funding_source TEXT NOT NULL,
  quota_day DATE NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  mime_type TEXT,
  has_sketch BOOLEAN NOT NULL,
  variation_index INTEGER NOT NULL DEFAULT 0,
  image_data_url TEXT,
  image_purged_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT generations_id_format CHECK (id ~ '^gen_[0-9a-f]{32}$'),
  CONSTRAINT generations_kind_valid CHECK (kind IN ('base', 'variation')),
  CONSTRAINT generations_mode_valid CHECK (mode IN ('product', 'architect', 'mechanical', 'artist')),
  CONSTRAINT generations_generation_mode_valid CHECK (generation_mode IN ('fast', 'balanced', 'premium')),
  CONSTRAINT generations_status_valid CHECK (status IN ('pending', 'processing', 'done', 'error')),
  CONSTRAINT generations_variation_index_nonnegative CHECK (variation_index >= 0),
  -- No paid funding source exists until a wallet migration adds one.
  CONSTRAINT generations_funding_source_valid CHECK (funding_source IN ('free_daily')),
  CONSTRAINT generations_free_is_basic_only CHECK (
    funding_source <> 'free_daily'
    OR (mode = 'product' AND generation_mode = 'balanced' AND kind = 'base')
  ),
  CONSTRAINT generations_finished_matches_status CHECK (
    (status IN ('done', 'error')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT generations_idempotency_unique UNIQUE (user_id, idempotency_key)
);

CREATE INDEX generations_user_created_idx ON generations (user_id, created_at DESC);
CREATE INDEX generations_active_lease_idx ON generations (lease_expires_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX generations_finished_idx ON generations (finished_at)
  WHERE finished_at IS NOT NULL;
