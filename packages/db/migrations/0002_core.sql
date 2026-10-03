-- 0002 · Core schema: DATA-MODEL.md §3 (v1.1) with the FREE-TIER.md §10 deltas folded in.
-- The schema is identical in every edition ("no migration" to upgrade): columns that only
-- the paid edition uses (watch_expires_at, last_push_at, kms_key_name, screenshot_keys, …)
-- are kept, nullable and unused here.
--
-- Additions beyond the docs (additive, documented in packages/db/README.md):
--   beta_allowlist.role, user_settings.role/last_active_at, mailbox.backfill_requested_at/
--   backfill_progress, email_template.ai_source_email_id is a composite (tenant-safe) FK,
--   llm_budget.scope (day|month rows), ai_batch.item_count/created_at, ai_batch_item.purpose/template_id.

-- ───────────────────────── global ─────────────────────────
CREATE TABLE beta_allowlist (                 -- invite gate (protects the unverified app's 100-user lifetime cap)
  email          citext PRIMARY KEY,
  role           text NOT NULL DEFAULT 'friend' CHECK (role IN ('owner','friend')),
  invited_by     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  used_at        timestamptz
);

-- ───────────────────────── per user ─────────────────────────
CREATE TABLE user_settings (
  user_id                   text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  role                      text NOT NULL DEFAULT 'friend' CHECK (role IN ('owner','friend')),
  timezone                  text NOT NULL DEFAULT 'UTC',
  ai_processing_consent_at  timestamptz,                -- in-app disclosure accepted; required before connect
  load_images_for_analysis  boolean NOT NULL DEFAULT true,  -- privacy mode = false (images-off analysis only)
  link_check_opt_in         boolean NOT NULL DEFAULT false,
  screenshot_retention_days int NOT NULL DEFAULT 30 CHECK (screenshot_retention_days BETWEEN 7 AND 365),
  backfill_window_days      int NOT NULL DEFAULT 90 CHECK (backfill_window_days IN (30, 90, 180)),
  digest_frequency          text NOT NULL DEFAULT 'daily' CHECK (digest_frequency IN ('off','daily','weekly')),
  last_active_at            timestamptz,                -- app opened (throttled writes); drives poll cadence (FREE-TIER §4.3)
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mailbox (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  provider                text NOT NULL CHECK (provider IN ('gmail','outlook')),
  provider_account_id     text NOT NULL,                 -- verified id_token `sub`
  email_address           citext NOT NULL,               -- users.getProfile emailAddress
  status                  text NOT NULL DEFAULT 'connecting'
                          CHECK (status IN ('connecting','active','needs_reauth','paused','disconnecting')),
  status_reason           text,                          -- e.g. invalid_grant, domain_policy, user_request
  granted_scopes          text[] NOT NULL DEFAULT '{}',
  dek_wrapped             bytea,                         -- per-mailbox DEK wrapped by the edf-keys KEK (FREE-TIER §9.2)
  kek_version             text NOT NULL DEFAULT 'keys:v1', -- keys:vN now; kms:N after §12 C; local:vN in development
  kms_key_name            text,                          -- paid edition only
  refresh_token_enc       bytea,                         -- ver ‖ nonce ‖ AES-256-GCM(ciphertext ‖ tag), DEK-sealed
  access_token_enc        bytea,                         -- sealed with edf-app ACCESS_TOKEN_KEYS (FREE-TIER §4.2)
  access_token_expires_at timestamptz,
  refresh_lease_until     timestamptz,                   -- lease for token refresh (no lock held across HTTP)
  history_id              numeric(20,0),                 -- Gmail sync cursor (uint64); compare in SQL only
  resync_pending          boolean NOT NULL DEFAULT false,
  poll_incomplete         boolean NOT NULL DEFAULT false, -- last poll stopped early; next tick continues
  next_poll_at            timestamptz,
  sync_lease_until        timestamptz,                   -- poll row lease (FREE-TIER §4.2 step 1)
  watch_expires_at        timestamptz,                   -- paid edition only (push)
  last_push_at            timestamptz,                   -- paid edition only (push)
  last_synced_at          timestamptz,
  needs_reauth_since      timestamptz,                   -- purge after 30 days
  backfill_state          text NOT NULL DEFAULT 'pending'
                          CHECK (backfill_state IN ('pending','running','done','failed')),
  backfill_generation     int NOT NULL DEFAULT 0,        -- bumps on re-import/resync; part of event ids
  backfill_requested_at   timestamptz,                   -- FIFO order for backfill admission (FREE-TIER §4.5)
  backfill_progress       jsonb NOT NULL DEFAULT '{}',   -- {slice, listed, windowDays, …} for the UI and resumption
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (provider, provider_account_id),                -- one live binding per Google account
  UNIQUE (provider, email_address)
);
CREATE INDEX mailbox_user      ON mailbox (user_id);
CREATE INDEX mailbox_watch_due ON mailbox (watch_expires_at) WHERE status = 'active';
CREATE INDEX mailbox_poll_due  ON mailbox (next_poll_at) WHERE status = 'active';
CREATE INDEX mailbox_backfill_queue ON mailbox (backfill_requested_at) WHERE backfill_state IN ('pending','running');

-- Shared per-mailbox Gmail quota bucket; EVERY Gmail call site reserves units here (DESIGN.md §5.2).
CREATE TABLE gmail_quota (
  mailbox_id              uuid PRIMARY KEY,
  user_id                 text NOT NULL,
  tokens                  real NOT NULL DEFAULT 5500,    -- capacity 5,500 units, refill 5,500/min (limit is 6,000)
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailbox (id, user_id) ON DELETE CASCADE
);

CREATE TABLE sender (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  address                 citext NOT NULL,
  display_name            text,
  domain                  text NOT NULL,                 -- registrable domain (tldts)
  esp_platform            text,
  esp_mta                 text,
  first_seen_at           timestamptz NOT NULL,
  last_seen_at            timestamptz NOT NULL,
  seen_before_window      boolean,                       -- sender existed before the backfill window
  email_count             int NOT NULL DEFAULT 0,
  unread_count            int NOT NULL DEFAULT 0,
  emails_per_week         real,
  frequency_band          text CHECK (frequency_band IN ('daily','several_weekly','weekly','monthly','rare')),
  read_rate_60d           real,                          -- read in Gmail OR opened in app
  type_distribution       jsonb NOT NULL DEFAULT '{}',
  primary_type            text,                          -- computed prior
  type_override           text,                          -- user correction ("always classify as …")
  one_click_unsubscribe   boolean,
  list_unsubscribe        jsonb,                         -- latest parsed header (user-initiated action only)
  unsubscribed_at         timestamptz,                   -- user clicked "open unsubscribe page"
  auth_summary            jsonb,
  avg_design_score        real,
  brand_profile           jsonb,
  user_importance_bias    smallint NOT NULL DEFAULT 0 CHECK (user_importance_bias BETWEEN -2 AND 2),
  muted                   boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (user_id, address)
);
CREATE INDEX sender_user_domain    ON sender (user_id, domain);
CREATE INDEX sender_user_lastseen  ON sender (user_id, last_seen_at DESC);
CREATE INDEX sender_user_name_trgm ON sender USING gin (user_id, display_name gin_trgm_ops); -- used via search_senders()

CREATE TABLE email_template (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL,
  sender_id               uuid NOT NULL,
  simhash                 bigint NOT NULL,               -- 64-bit simhash of DOM skeleton; match = Hamming ≤ 3
  first_seen_at           timestamptz NOT NULL,
  last_seen_at            timestamptz NOT NULL,
  email_count             int NOT NULL DEFAULT 1,
  seen_count              int NOT NULL DEFAULT 1,        -- AI review only for templates seen ≥ 2 times (FREE-TIER §5.7)
  ai_review               jsonb,                         -- template-level criteria (L8; H7/I6 of the sample)
  ai_model                text,
  ai_reviewed_at          timestamptz,
  ai_source_email_id      uuid,
  exemplar_email_id       uuid,                          -- the rendered sample (most recent at selection time)
  exemplar_rendered_at    timestamptz,
  classification          jsonb,                         -- cached LLM classification for (sender, template)
  classified_by           text,
  classified_at           timestamptz,
  UNIQUE (id, user_id),
  UNIQUE (sender_id, simhash),
  FOREIGN KEY (sender_id, user_id) REFERENCES sender (id, user_id) ON DELETE CASCADE
);
CREATE INDEX email_template_user_sender ON email_template (user_id, sender_id);
CREATE INDEX email_template_exemplar_due ON email_template (user_id, last_seen_at DESC);

CREATE TABLE email (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL,
  mailbox_id              uuid NOT NULL,
  sender_id               uuid,
  template_id             uuid,
  provider_message_id     text NOT NULL,
  provider_thread_id      text,
  gmail_history_id        numeric(20,0) NOT NULL,        -- Message.historyId: last change applied (label-race guard)
  received_at             timestamptz NOT NULL,          -- internalDate
  subject                 text,
  from_address            citext,
  from_name               text,
  snippet                 text,                          -- NULL for security-sensitive mail
  label_ids               text[] NOT NULL DEFAULT '{}',
  is_unread               boolean NOT NULL DEFAULT true, -- mirrored from Gmail (read-only scope)
  opened_in_app_at        timestamptz,                   -- app-local read state (never written to Gmail)
  done_at                 timestamptz,                   -- app-local triage ("Done")
  pinned_at               timestamptz,
  is_starred              boolean NOT NULL DEFAULT false,
  gmail_important         boolean NOT NULL DEFAULT false,
  gmail_category          text CHECK (gmail_category IN ('promotions','updates','social','forums','personal')),
  in_trash                boolean NOT NULL DEFAULT false,
  in_spam                 boolean NOT NULL DEFAULT false,
  sender_muted            boolean NOT NULL DEFAULT false, -- denormalized from sender.muted (bulk-updated on mute)
  is_hidden               boolean GENERATED ALWAYS AS (in_trash OR in_spam OR sender_muted) STORED,
  size_bytes              int,
  html_bytes              int,                           -- decoded text/html size (clip check)
  language                text,                          -- ISO 639-1
  security_sensitive      boolean NOT NULL DEFAULT false, -- OTP / reset / magic link: minimized storage, no render/AI
  -- classification
  is_subscription         boolean NOT NULL,
  subscription_score      smallint,
  primary_type            text NOT NULL CHECK (primary_type IN ('promotional','newsletter','product_update','lifecycle',
                            'transactional','account_security','account_notice','notification','event','social',
                            'community','survey','other')),
  subtype                 text,
  secondary_tags          text[] NOT NULL DEFAULT '{}',
  type_confidence         real,
  type_source             text NOT NULL CHECK (type_source IN ('rule','sender_prior','template_cache','llm','user','pending')),
  importance              text NOT NULL DEFAULT 'normal' CHECK (importance IN ('high','normal','low')),
  importance_score        smallint CHECK (importance_score BETWEEN 0 AND 100),
  importance_reasons      text[] NOT NULL DEFAULT '{}',
  importance_expires_at   timestamptz,                   -- earliest lapsing time-bound boost (OTP 1h, deal ≤48h, shipping 14d)
  -- header-derived facts
  list_id                 text,
  one_click_unsubscribe   boolean NOT NULL DEFAULT false,
  auth_result             text NOT NULL DEFAULT 'unknown' CHECK (auth_result IN ('pass','fail','none','unknown')),
  suspicious              boolean NOT NULL DEFAULT false, -- DMARC fail, unaligned, no ARC pass (DESIGN.md §7.8)
  esp_platform            text,
  tracker_count           smallint NOT NULL DEFAULT 0,
  utm_campaign            text,
  -- design (denormalized from email_analysis for filtering/sorting)
  design_status           text NOT NULL DEFAULT 'pending'
                          CHECK (design_status IN ('pending','done','failed','skipped','plain_text')),
  design_source           text NOT NULL DEFAULT 'none' CHECK (design_source IN ('none','static','template','render')),
  design_ai_state         text NOT NULL DEFAULT 'pending'
                          CHECK (design_ai_state IN ('pending','queued','done','from_template','flagged','failed','not_applicable')),
  design_score            smallint CHECK (design_score BETWEEN 0 AND 100),
  design_band             text CHECK (design_band IN ('excellent','good','needs_work','poor')),
  design_capped           boolean,
  design_provisional      boolean,                       -- excluded from Good/Bad chips (DESIGN-SCORE §3.1)
  design_issues           text[] NOT NULL DEFAULT '{}'
                          CHECK (design_issues <@ ARRAY['image_only','contrast','mobile','clipped','broken_images']::text[]),
  design_confidence       text CHECK (design_confidence IN ('high','medium','low')),
  font_source             text NOT NULL DEFAULT 'none' CHECK (font_source IN ('none','static','template','render')),
  font_families           text[] NOT NULL DEFAULT '{}' CHECK (cardinality(font_families) <= 12),
  uses_web_fonts          boolean NOT NULL DEFAULT false,
  -- deals (denormalized)
  has_deal                boolean NOT NULL DEFAULT false,
  deal_has_code           boolean NOT NULL DEFAULT false,
  deal_ends_at            timestamptz,                   -- LATEST expiry among the email's deals
  -- search: computed at INSERT from subject + sender + excerpt; the excerpt itself is NOT stored
  search_tsv              tsvector NOT NULL DEFAULT ''::tsvector,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (mailbox_id, provider_message_id),
  FOREIGN KEY (mailbox_id, user_id)  REFERENCES mailbox (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id, user_id)   REFERENCES sender (id, user_id) ON DELETE SET NULL (sender_id),
  FOREIGN KEY (template_id, user_id) REFERENCES email_template (id, user_id) ON DELETE SET NULL (template_id)
) WITH (fillfactor = 85);

ALTER TABLE email_template
  ADD FOREIGN KEY (ai_source_email_id, user_id) REFERENCES email (id, user_id) ON DELETE SET NULL (ai_source_email_id),
  ADD FOREIGN KEY (exemplar_email_id, user_id)  REFERENCES email (id, user_id) ON DELETE SET NULL (exemplar_email_id);
CREATE INDEX email_template_ai_source ON email_template (ai_source_email_id) WHERE ai_source_email_id IS NOT NULL;
CREATE INDEX email_template_exemplar  ON email_template (exemplar_email_id)  WHERE exemplar_email_id IS NOT NULL;

-- Timeline + covering columns for facet counts (is_unread deliberately NOT included → keeps HOT updates).
CREATE INDEX email_user_timeline ON email (user_id, received_at DESC, id DESC)
  INCLUDE (primary_type, design_band, importance, has_deal, is_subscription, sender_id, mailbox_id)
  WHERE NOT is_hidden;
CREATE INDEX email_user_type     ON email (user_id, primary_type, received_at DESC) WHERE NOT is_hidden;
CREATE INDEX email_user_score    ON email (user_id, design_score DESC, id DESC) WHERE NOT is_hidden AND design_score IS NOT NULL;
CREATE INDEX email_user_sender   ON email (user_id, sender_id, received_at DESC);            -- also serves the sender FK
CREATE INDEX email_user_template ON email (user_id, template_id) WHERE template_id IS NOT NULL; -- template FK
CREATE INDEX email_user_attention ON email (user_id, received_at DESC)
  WHERE importance = 'high' AND done_at IS NULL AND NOT is_hidden;
CREATE INDEX email_user_deals    ON email (user_id, deal_ends_at) WHERE has_deal;
CREATE INDEX email_importance_exp ON email (importance_expires_at) WHERE importance_expires_at IS NOT NULL;
CREATE INDEX email_user_search   ON email USING gin (user_id, search_tsv);                   -- used via search_emails()
CREATE INDEX email_user_design_source ON email (user_id, design_source);                     -- FREE-TIER §10

CREATE TABLE email_analysis (
  email_id                uuid PRIMARY KEY,
  user_id                 text NOT NULL,
  scoring_version         text NOT NULL,
  renderer_version        text,
  features                jsonb,                         -- NULL after compaction (FREE-TIER §5.4)
  checks                  jsonb NOT NULL,                -- [{id,status,s,value}]; '[]' after compaction
  pillar_scores           jsonb NOT NULL,
  raw_score               real,
  caps                    text[] NOT NULL DEFAULT '{}',
  confidence              real NOT NULL,
  ai_review               jsonb,                         -- per criterion: level, evidence (URLs/emails stripped), source
  ai_model                text,
  trust                   jsonb,                         -- Sender Trust & Compliance badge
  score_summary           jsonb,                         -- ~0.5 KB, incl. font summary (kept after compaction)
  features_compacted_at   timestamptz,
  render_ref_email_id     uuid,                          -- template coverage: the sample it inherits from
  renderer_host           text,                          -- 'sandbox' | 'local' | …
  chromium_version        text,
  screenshot_keys         jsonb,                         -- paid edition only (always NULL here)
  screenshots_full_until  timestamptz,                   -- paid edition only
  render_ms               int,
  error                   text,
  analyzed_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (render_ref_email_id, user_id) REFERENCES email (id, user_id) ON DELETE SET NULL (render_ref_email_id)
);
CREATE INDEX email_analysis_version ON email_analysis (scoring_version);
CREATE INDEX email_analysis_shots   ON email_analysis (screenshots_full_until) WHERE screenshots_full_until IS NOT NULL;
CREATE INDEX email_analysis_render_ref ON email_analysis (render_ref_email_id) WHERE render_ref_email_id IS NOT NULL;
CREATE INDEX email_analysis_compaction ON email_analysis (user_id, analyzed_at) WHERE features IS NOT NULL;

CREATE TABLE deal (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  email_id                uuid NOT NULL,
  user_id                 text NOT NULL,
  sender_id               uuid,
  kind                    text NOT NULL CHECK (kind IN ('percent_off','amount_off','bogo','free_shipping','gift','other')),
  value                   numeric(10,2),
  currency                text CHECK (currency ~ '^[A-Z]{3}$'),
  is_up_to                boolean NOT NULL DEFAULT false,
  min_spend               numeric(10,2),
  code                    text,                          -- may be per-recipient → private, never aggregated
  starts_at               timestamptz,
  ends_at                 timestamptz,                   -- undated deals: received_at + 14d, low confidence
  ends_at_confidence      real,
  source                  text NOT NULL CHECK (source IN ('jsonld','regex','llm')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_dedupe UNIQUE NULLS NOT DISTINCT (email_id, kind, value, code),
  FOREIGN KEY (email_id, user_id)  REFERENCES email (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id, user_id) REFERENCES sender (id, user_id) ON DELETE SET NULL (sender_id)
);
CREATE INDEX deal_user_ends   ON deal (user_id, ends_at);
CREATE INDEX deal_user_sender ON deal (user_id, sender_id) WHERE sender_id IS NOT NULL;

-- Every Gmail message id we have seen, with its processing state. Content-free (DESIGN.md §5.3).
CREATE TABLE message_ledger (
  mailbox_id              uuid NOT NULL,
  user_id                 text NOT NULL,
  provider_message_id     text NOT NULL,
  state                   text NOT NULL CHECK (state IN ('pending','pending_full','stored','skipped','failed')),
  reason                  text CHECK (reason IN ('personal','sent','draft','chat','spam','auto_reply','parse_error',
                                                 'gmail_error','too_large')),
  source                  text NOT NULL CHECK (source IN ('backfill','sync','resync','reconcile')),
  attempts                smallint NOT NULL DEFAULT 0,
  next_attempt_at         timestamptz,
  pending_label_delta     jsonb,                         -- label changes seen before the row was stored
  delta_history_id        numeric(20,0),
  classifier_version      text,                          -- re-evaluate skipped rows when the classifier changes
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mailbox_id, provider_message_id),
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailbox (id, user_id) ON DELETE CASCADE
);
CREATE INDEX message_ledger_redrive ON message_ledger (next_attempt_at) WHERE state IN ('pending','pending_full');
CREATE INDEX message_ledger_drain   ON message_ledger (mailbox_id, source, created_at) WHERE state IN ('pending','pending_full');
CREATE INDEX message_ledger_failed  ON message_ledger (mailbox_id, updated_at) WHERE state = 'failed';
CREATE INDEX message_ledger_skipped ON message_ledger (updated_at) WHERE state = 'skipped';

CREATE TABLE sync_run (                               -- only backfill / resync / failed runs are logged; 30-day retention
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL,
  mailbox_id              uuid NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('backfill','incremental','reconcile','resync')),
  status                  text NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  stats                   jsonb NOT NULL DEFAULT '{}',
  error                   text,                          -- error code only, never message content
  workflow_run_id         text,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  FOREIGN KEY (mailbox_id, user_id) REFERENCES mailbox (id, user_id) ON DELETE CASCADE
);
CREATE INDEX sync_run_mailbox ON sync_run (mailbox_id, started_at DESC);
CREATE INDEX sync_run_started ON sync_run (started_at);
CREATE UNIQUE INDEX sync_run_workflow ON sync_run (workflow_run_id) WHERE workflow_run_id IS NOT NULL;

CREATE TABLE saved_view (                             -- user-created views only; built-in views are defined in code
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name                    text NOT NULL,
  filters                 jsonb NOT NULL,                -- same schema as the filter state (Zod)
  sort                    text NOT NULL DEFAULT 'received_desc',
  position                int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE user_feedback (                          -- that user's corrections → that user's personalization only
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  email_id                uuid,
  sender_id               uuid,
  field                   text NOT NULL CHECK (field IN ('primary_type','importance','is_subscription','is_personal','design_disagree')),
  old_value               text,
  new_value               text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, user_id)  REFERENCES email (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id, user_id) REFERENCES sender (id, user_id) ON DELETE CASCADE
);
CREATE INDEX user_feedback_user   ON user_feedback (user_id, created_at DESC);
CREATE INDEX user_feedback_email  ON user_feedback (email_id)  WHERE email_id IS NOT NULL;
CREATE INDEX user_feedback_sender ON user_feedback (sender_id) WHERE sender_id IS NOT NULL;

-- Explicit, per-message consent to let the admin view one email's analysis (Limited Use: "no humans reading").
CREATE TABLE review_share (
  email_id                uuid NOT NULL,
  user_id                 text NOT NULL,
  reason                  text NOT NULL CHECK (reason IN ('design_disagree','support')),
  shared_at               timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,          -- 30 days
  PRIMARY KEY (email_id),
  FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE CASCADE
);

CREATE TABLE llm_usage (                              -- metering; no content
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  day                     date NOT NULL,
  purpose                 text NOT NULL CHECK (purpose IN ('classify','design_review','copy_review','deal_verify')),
  model                   text NOT NULL,
  batch                   boolean NOT NULL DEFAULT false,
  requests                int NOT NULL DEFAULT 0,
  input_tokens            bigint NOT NULL DEFAULT 0,
  cached_input_tokens     bigint NOT NULL DEFAULT 0,
  output_tokens           bigint NOT NULL DEFAULT 0,
  cost_usd                numeric(12,6) NOT NULL DEFAULT 0,
  UNIQUE (user_id, day, purpose, model, batch)
);

-- Atomic per-user spend reservation: day rows and month rows (FREE-TIER §6.5, via reserve_llm()).
CREATE TABLE llm_budget (
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  scope                   text NOT NULL CHECK (scope IN ('day','month')),
  day                     date NOT NULL,                 -- the day, or the first day of the month
  reserved_usd            numeric(10,4) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  PRIMARY KEY (user_id, scope, day),
  CHECK (scope = 'day' OR extract(day FROM day) = 1)
);

CREATE TABLE data_request (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind                    text NOT NULL CHECK (kind IN ('export','delete_account','disconnect_purge')),
  status                  text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  result_blob_key         text,                          -- paid edition only (always NULL here)
  requested_at            timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz
);
CREATE UNIQUE INDEX data_request_one_active ON data_request (user_id, kind) WHERE status IN ('queued','running');

-- Security-relevant events. No email content. Pseudonymous after account deletion; kept 1 year.
CREATE TABLE audit_log (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                 text,                          -- NOT a FK: survives account deletion (pseudonymous id)
  actor                   text NOT NULL,                 -- 'user' | 'system' | 'admin:<id>' | 'edf-keys' | 'edf-view'
  action                  text NOT NULL,
  target                  text,
  ip_hash                 text,                          -- HMAC(ip)
  user_agent              text,
  metadata                jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user    ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_created ON audit_log USING brin (created_at);

-- Deferred Blob deletion (paid edition). Kept for schema identity; never fires here (no screenshot_keys).
CREATE TABLE blob_gc (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id                 text NOT NULL,
  pathname                text NOT NULL,
  enqueued_at             timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION enqueue_blob_gc() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.screenshot_keys IS NOT NULL THEN
    INSERT INTO blob_gc (user_id, pathname)
    SELECT OLD.user_id, v FROM jsonb_each_text(OLD.screenshot_keys) AS t(k, v) WHERE v IS NOT NULL;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER email_analysis_blob_gc AFTER DELETE ON email_analysis
  FOR EACH ROW EXECUTE FUNCTION enqueue_blob_gc();

-- ───────────────────────── free-tier tables (FREE-TIER.md §10) ─────────────────────────

-- Render queue (tenant-scoped). One active request per email.
CREATE TABLE render_request (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL,
  email_id                uuid NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('on_demand','exemplar','fill')),
  state                   text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','done','failed')),
  want_ai                 boolean NOT NULL DEFAULT false,  -- on-demand "Run AI review" (real time)
  attempts                smallint NOT NULL DEFAULT 0,
  error                   text,                            -- fixed status code only
  requested_at            timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX render_request_active ON render_request (email_id) WHERE state IN ('queued','running');
CREATE INDEX render_request_due ON render_request (user_id, requested_at) WHERE state = 'queued';
CREATE INDEX render_request_done ON render_request (updated_at) WHERE state IN ('done','failed');

-- Claude Message Batches (no tenant data). The 'submitting' row is committed BEFORE batches.create (§5.1 step 7).
CREATE TABLE ai_batch (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  anthropic_batch_id      text UNIQUE,
  purpose                 text NOT NULL CHECK (purpose IN ('design_review','classify')),
  state                   text NOT NULL CHECK (state IN ('submitting','submitted','ended','failed')),
  reserved_usd            numeric(10,4) NOT NULL DEFAULT 0,
  settled_usd             numeric(10,4),
  item_count              int NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  submitted_at            timestamptz,
  ended_at                timestamptz
);
CREATE INDEX ai_batch_open ON ai_batch (created_at) WHERE state IN ('submitting','submitted');

-- Batch items (tenant table). Results are written under withUser(user_id), looked up by custom_id.
CREATE TABLE ai_batch_item (
  custom_id               text PRIMARY KEY CHECK (custom_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  batch_id                uuid NOT NULL REFERENCES ai_batch (id) ON DELETE CASCADE,
  user_id                 text NOT NULL,
  email_id                uuid NOT NULL,
  template_id             uuid,
  purpose                 text NOT NULL CHECK (purpose IN ('design_review','classify')),
  reserved_usd            numeric(10,4) NOT NULL DEFAULT 0,
  settled_usd             numeric(10,4),
  FOREIGN KEY (email_id, user_id)    REFERENCES email (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (template_id, user_id) REFERENCES email_template (id, user_id) ON DELETE SET NULL (template_id)
);
CREATE INDEX ai_batch_item_batch ON ai_batch_item (batch_id);
CREATE INDEX ai_batch_item_email ON ai_batch_item (email_id);
CREATE INDEX ai_batch_item_template ON ai_batch_item (template_id) WHERE template_id IS NOT NULL;

-- Global monthly AI spend (no tenant data), locked by reserve_llm().
CREATE TABLE llm_budget_global (
  period                  date PRIMARY KEY CHECK (extract(day FROM period) = 1),
  reserved_usd            numeric(10,4) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  cap_usd                 numeric(10,4) NOT NULL
);

-- Self-metering (FREE-TIER §8.1): one row per (day, resource), summed by add_usage().
CREATE TABLE usage_ledger (
  day                     date NOT NULL,
  resource                text NOT NULL CHECK (resource ~ '^[a-z0-9_.:-]{1,64}$'),
  amount                  numeric(18,6) NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, resource)
);

-- Kill switches, governor state, calibration factors, neon_period_start… (instant, no redeploy).
CREATE TABLE app_setting (
  key                     text PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]{1,64}$'),
  value                   jsonb NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Operational errors: codes and hashes only, never content (30 days).
CREATE TABLE app_error (
  id                      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at                      timestamptz NOT NULL DEFAULT now(),
  job                     text NOT NULL,
  code                    text NOT NULL,
  mailbox_hash            text,
  detail_code             text
);
CREATE INDEX app_error_at ON app_error USING brin (at);

-- Google accounts that ever granted the connector (hashed `sub`): the unverified app's lifetime cap
-- is 100 accounts EVER (FREE-TIER §0), so this is never purged. Alert at 70, invites off at 90.
CREATE TABLE oauth_subject_seen (
  sub_hash                text PRIMARY KEY CHECK (sub_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at           timestamptz NOT NULL DEFAULT now()
);

-- Heartbeats, leases and counters (single row).
CREATE TABLE system_state (
  id                      boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_tick_at            timestamptz,
  last_maintenance_at     timestamptz,
  last_render_batch_at    timestamptz,
  last_cron_at            timestamptz,
  inngest_paused          boolean NOT NULL DEFAULT false,
  backfill_lease_mailbox  uuid,                          -- the one running backfill (FREE-TIER §4.5)
  backfill_lease_until    timestamptz,
  kick_window_start       timestamptz,                   -- continuation kicks: ≤ 6 per hour
  kick_count              int NOT NULL DEFAULT 0,
  signin_wake_day         date,                          -- unauthenticated-wake breaker: ≤ 10 per day
  signin_wake_count       int NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_state DEFAULT VALUES;

INSERT INTO app_setting (key, value) VALUES
  ('governor',            '{"level":0,"since":null,"triggers":[],"belowSince":null}'),
  ('ai.paused',           '{"paused":false,"reason":null,"since":null}'),
  ('ai.cap_usd',          '5'),                          -- G: the Console monthly limit; the app stops at 0.9 × G
  ('kill.ingest',         'false'),
  ('kill.render',         'false'),
  ('kill.ai',             'false'),
  ('kill.backfill',       'false'),
  ('invites.enabled',     'true'),
  ('calibration',         '{"vercel_cpu":1.5,"sandbox_cpu":1.0}'),
  ('neon.period_start',   'null'),
  ('render.lite',         'false');
