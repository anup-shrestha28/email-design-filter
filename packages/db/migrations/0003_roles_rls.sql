-- 0003 · Roles, grants and row-level security (DATA-MODEL.md §4, FREE-TIER.md §10).
-- The migration role is the Neon owner (member of neon_superuser → BYPASSRLS), so the app must
-- NEVER use it: the runtime role `app_rw` is created here via SQL (console/API-created roles
-- join neon_superuser). Its password is set by the migration runner from APP_RW_PASSWORD.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;  -- owns SECURITY DEFINER functions only
  END IF;
  -- Re-assert the attributes in case the roles pre-existed with different ones. (SUPERUSER can only be
  -- changed by a superuser, which the migration role is not; the app's boot assertion rejects it anyway.)
  ALTER ROLE app_rw     NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  ALTER ROLE app_system NOLOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_rw', current_database());
END $$;

-- Functions are EXECUTE-able by PUBLIC by default: turn that off for everything created from now on.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION enqueue_blob_gc() FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO app_rw, app_system;

-- ── app_rw: tenant tables (RLS below) and Better Auth tables ──
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user", session, account, verification,
  user_settings, mailbox, gmail_quota, sender, email_template, email, email_analysis, deal,
  message_ledger, sync_run, saved_view, user_feedback, review_share, llm_usage, data_request, blob_gc,
  render_request, ai_batch_item
  TO app_rw;
-- llm_budget: read only; every write goes through reserve_llm()/settle_llm() (atomic, capped).
GRANT SELECT ON llm_budget TO app_rw;
GRANT SELECT, INSERT ON audit_log TO app_rw;                 -- append-only from the app
REVOKE ALL ON beta_allowlist FROM app_rw;                    -- only through is_invited()/claim_invite()/…

-- ── app_rw: system tables (no tenant data; FREE-TIER.md §10) ──
GRANT SELECT, INSERT ON usage_ledger, app_error TO app_rw;  -- aggregation via add_usage(); retention via purge_system_rows()
GRANT SELECT, UPDATE ON system_state, app_setting TO app_rw;
GRANT SELECT, INSERT, UPDATE ON ai_batch TO app_rw;
GRANT SELECT ON llm_budget_global TO app_rw;
GRANT SELECT, INSERT ON oauth_subject_seen TO app_rw;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- ── Tenant policies: FORCE RLS, transaction-local app.user_id, fails closed ──
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mailbox','gmail_quota','user_settings','sender','email_template','email','email_analysis',
    'deal','message_ledger','sync_run','saved_view','user_feedback','review_share','llm_usage','llm_budget',
    'data_request','blob_gc','render_request','ai_batch_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I TO app_rw
      USING      (user_id = NULLIF(current_setting('app.user_id', true), ''))
      WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))$p$, t);
  END LOOP;
END $$;

-- audit_log: anyone may append (incl. system/anonymous events); users read only their own; no update/delete.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_insert   ON audit_log FOR INSERT TO app_rw WITH CHECK (true);
CREATE POLICY audit_read_own ON audit_log FOR SELECT TO app_rw
  USING (user_id = NULLIF(current_setting('app.user_id', true), ''));

-- ── app_system: minimal column grants + explicit policies for the definer functions (never BYPASSRLS) ──
GRANT SELECT (id, user_id, provider, email_address, status, watch_expires_at, last_push_at, last_synced_at,
              needs_reauth_since, next_poll_at, poll_incomplete, sync_lease_until, backfill_state,
              backfill_requested_at, created_at)
  ON mailbox TO app_system;
GRANT SELECT (id, user_id, search_tsv, received_at, is_hidden, importance_expires_at) ON email TO app_system;
GRANT SELECT (id, user_id, display_name, address, domain, email_count, last_seen_at) ON sender TO app_system;
GRANT SELECT (mailbox_id, user_id, provider_message_id, state, source, attempts, next_attempt_at, created_at, updated_at)
  ON message_ledger TO app_system;
GRANT DELETE ON message_ledger TO app_system;
GRANT SELECT (email_id, user_id, screenshots_full_until) ON email_analysis TO app_system;
GRANT SELECT (user_id, role, last_active_at, backfill_window_days, load_images_for_analysis) ON user_settings TO app_system;
GRANT SELECT (id, user_id, email_id, kind, state, requested_at, updated_at) ON render_request TO app_system;
GRANT DELETE ON render_request TO app_system;
GRANT SELECT (id, user_id, started_at) ON sync_run TO app_system;
GRANT DELETE ON sync_run TO app_system;
GRANT SELECT (custom_id, batch_id, user_id, email_id, template_id, purpose, reserved_usd, settled_usd) ON ai_batch_item TO app_system;
GRANT SELECT, INSERT, UPDATE ON llm_budget TO app_system;
GRANT SELECT, INSERT, UPDATE ON llm_budget_global TO app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_ledger TO app_system;
GRANT SELECT, DELETE ON app_error TO app_system;
GRANT SELECT, DELETE ON audit_log TO app_system;
GRANT SELECT, DELETE ON ai_batch TO app_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON beta_allowlist TO app_system;
GRANT SELECT (id, expires_at) ON session TO app_system;
GRANT DELETE ON session TO app_system;
GRANT SELECT (id, expires_at) ON verification TO app_system;
GRANT DELETE ON verification TO app_system;
GRANT SELECT, INSERT, DELETE ON blob_gc TO app_system;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_system;

CREATE POLICY system_read   ON mailbox        FOR SELECT TO app_system USING (true);
CREATE POLICY system_read   ON email          FOR SELECT TO app_system USING (true);
CREATE POLICY system_read   ON sender         FOR SELECT TO app_system USING (true);
CREATE POLICY system_read   ON message_ledger FOR SELECT TO app_system USING (true);
CREATE POLICY system_purge  ON message_ledger FOR DELETE TO app_system USING (state = 'skipped');
CREATE POLICY system_read   ON email_analysis FOR SELECT TO app_system USING (true);
CREATE POLICY system_read   ON user_settings  FOR SELECT TO app_system USING (true);
CREATE POLICY system_read   ON render_request FOR SELECT TO app_system USING (true);
CREATE POLICY system_purge  ON render_request FOR DELETE TO app_system USING (state IN ('done','failed'));
CREATE POLICY system_read   ON sync_run       FOR SELECT TO app_system USING (true);
CREATE POLICY system_purge  ON sync_run       FOR DELETE TO app_system USING (true);
CREATE POLICY system_read   ON ai_batch_item  FOR SELECT TO app_system USING (true);
CREATE POLICY system_all    ON llm_budget     FOR ALL    TO app_system USING (true) WITH CHECK (true);
CREATE POLICY system_all    ON blob_gc        FOR ALL    TO app_system USING (true) WITH CHECK (true);
CREATE POLICY system_read   ON audit_log      FOR SELECT TO app_system USING (true);
CREATE POLICY system_purge  ON audit_log      FOR DELETE TO app_system USING (created_at < now() - interval '365 days');
