-- 0001 · Extensions and Better Auth tables (login only; no RLS — DATA-MODEL.md §2).
-- Column names are snake_case; the Drizzle schema maps Better Auth's camelCase field names.
-- Rate-limit storage is "memory" (FREE-TIER.md §9.1), so there is no rateLimit table.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE TABLE "user" (
  id              text PRIMARY KEY,
  name            text NOT NULL,
  email           text NOT NULL UNIQUE,
  email_verified  boolean NOT NULL DEFAULT false,
  image           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id              text PRIMARY KEY,
  expires_at      timestamptz NOT NULL,
  token           text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  ip_address      text,                                   -- disableIpTracking: stays NULL
  user_agent      text,
  user_id         text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_id ON session (user_id);

CREATE TABLE account (
  id                        text PRIMARY KEY,
  account_id                text NOT NULL,
  provider_id               text NOT NULL,
  user_id                   text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token              text,                         -- login client only; basic scopes, encrypted by Better Auth
  refresh_token             text,
  id_token                  text,
  access_token_expires_at   timestamptz,
  refresh_token_expires_at  timestamptz,
  scope                     text,
  password                  text,                         -- unused (Google sign-in only)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);
CREATE INDEX account_user_id ON account (user_id);

CREATE TABLE verification (
  id              text PRIMARY KEY,
  identifier      text NOT NULL,
  value           text NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_identifier ON verification (identifier);
