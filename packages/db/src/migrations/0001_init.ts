// Initial schema. Every table from the plan's data model, plus idempotency keys (replaces Redis).
// gen_random_uuid() is built into PostgreSQL 13+, so no extensions are needed.
export const id = '0001_init';

export const up = /* sql */ `
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id      text UNIQUE,                       -- Entra object ID
  email            text NOT NULL UNIQUE CHECK (email = lower(email)),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleting', 'deleted', 'banned')),
  age_confirmed_at timestamptz,
  region           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('photo', 'vendor_processing', 'analytics', 'marketing')),
  version    text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX consents_user ON consents (user_id);

CREATE TABLE profiles (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       jsonb NOT NULL,                          -- validated by @stylist/contracts Profile
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person_photos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key   text NOT NULL,
  processed_key text,
  status        text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'checking', 'accepted', 'rejected', 'deleted')),
  checks        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX person_photos_user ON person_photos (user_id);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  marketplace text NOT NULL,
  occasion    text NOT NULL,
  prompt      text,
  version     integer NOT NULL DEFAULT 0,             -- bumped on every item change; used by the debounce
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id, started_at DESC);

CREATE TABLE products (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  marketplace   text NOT NULL,
  external_id   text NOT NULL,
  variant       text NOT NULL DEFAULT '',
  url           text NOT NULL,
  title         text NOT NULL,
  brand         text,
  price         numeric(12, 2),
  currency      char(3),
  category      text,
  colour        text,
  pattern       text,
  image_keys    text[] NOT NULL DEFAULT '{}',
  classified_at timestamptz,
  last_seen     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (marketplace, external_id, variant)
);

CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES products(id),
  kind        text NOT NULL,
  at          timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_received ON events (received_at);   -- cleanup job deletes rows older than 90 days
CREATE INDEX events_session ON events (session_id);

CREATE TABLE session_items (
  session_id   uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id),
  signal_score numeric(8, 2) NOT NULL DEFAULT 0,
  pinned       boolean NOT NULL DEFAULT false,
  removed      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, product_id)
);

CREATE TABLE generations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'gathering', 'planning', 'rendering', 'checking', 'done', 'failed', 'cancelled')),
  cache_hash     text,
  plan           jsonb,
  result_keys    text[] NOT NULL DEFAULT '{}',
  prompt_version text,
  models_used    jsonb,
  cost_micros    bigint NOT NULL DEFAULT 0,
  latency_ms     integer,
  error          text,
  deadline_at    timestamptz NOT NULL DEFAULT now() + interval '120 seconds',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX generations_open ON generations (deadline_at) WHERE status NOT IN ('done', 'failed', 'cancelled');
CREATE INDEX generations_cache ON generations (cache_hash) WHERE status = 'done';
CREATE INDEX generations_user ON generations (user_id, created_at DESC);

CREATE TABLE feedback (
  generation_id uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  rating        smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_calls (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generation_id uuid REFERENCES generations(id) ON DELETE SET NULL,
  provider      text NOT NULL,
  model         text NOT NULL,
  task          text NOT NULL,
  input_units   integer,
  output_units  integer,
  cost_micros   bigint NOT NULL DEFAULT 0,
  latency_ms    integer,
  status        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_calls_created ON model_calls (created_at);

-- Credits: balance = SUM(amount). Never stored as a single number.
CREATE TABLE credit_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount        integer NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('grant', 'reserve', 'spend', 'refund', 'purchase', 'expiry')),
  generation_id uuid,
  period        text,                                  -- 'YYYY-MM' for monthly grants
  expires_at    timestamptz,                           -- free grants may expire; purchases never do (Apple 3.1.1)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'purchase' OR expires_at IS NULL)
);
CREATE INDEX credit_ledger_user ON credit_ledger (user_id);
CREATE UNIQUE INDEX credit_ledger_one_grant_per_month ON credit_ledger (user_id, period) WHERE kind = 'grant';
CREATE UNIQUE INDEX credit_ledger_once_per_job ON credit_ledger (generation_id, kind) WHERE generation_id IS NOT NULL;

CREATE TABLE looks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  generation_id uuid REFERENCES generations(id) ON DELETE SET NULL,
  items         uuid[] NOT NULL DEFAULT '{}',
  saved         boolean NOT NULL DEFAULT false,
  shared        boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE palettes (
  id      text PRIMARY KEY,                            -- e.g. 'cool_winter'
  name    text NOT NULL,
  best    text[] NOT NULL,
  accent  text[] NOT NULL,
  avoid   text[] NOT NULL,
  rules   jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE style_rules_versions (
  version        text PRIMARY KEY,
  rules          jsonb NOT NULL,
  prompt_version text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE preference_signals (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('liked', 'disliked', 'skipped', 'wore')),
  subject    text NOT NULL,
  weight     numeric(6, 2) NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX preference_signals_user ON preference_signals (user_id);

-- Replaces Redis for request idempotency.
CREATE TABLE idempotency_keys (
  key        text PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  response   jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idempotency_keys_created ON idempotency_keys (created_at);
`;

export const down = /* sql */ `
DROP TABLE IF EXISTS idempotency_keys, preference_signals, style_rules_versions, palettes, looks,
  credit_ledger, model_calls, feedback, generations, session_items, events, products, sessions,
  person_photos, profiles, consents, users CASCADE;
`;
