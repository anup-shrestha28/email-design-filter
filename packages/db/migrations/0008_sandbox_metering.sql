-- Sandbox metering from the Sandbox API (FREE-TIER.md §5.1 "Metering"): the tick's sweep lists the
-- account's VMs and counts each finished one exactly once, so a VM left behind by a failed step is
-- still counted. The dedupe row and its usage_ledger amounts commit in one transaction.
-- Names are platform-generated (no user data). The sweep looks back 48 h; rows are kept 14 days.
CREATE TABLE sandbox_metered (
  name                    text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 200),
  created_at              timestamptz NOT NULL,
  metered_at              timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON sandbox_metered TO app_rw;
GRANT SELECT, DELETE ON sandbox_metered TO app_system;

-- Retention (same body as 0004, plus sandbox_metered). Replacing keeps the owner (app_system) and grants.
GRANT app_system TO CURRENT_USER WITH SET TRUE;
CREATE OR REPLACE FUNCTION public.purge_system_rows()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r jsonb := '{}'; n bigint;
BEGIN
  DELETE FROM public.usage_ledger WHERE day < current_date - 400;                     GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('usage_ledger', n);
  DELETE FROM public.app_error WHERE at < now() - interval '30 days';                 GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('app_error', n);
  DELETE FROM public.audit_log WHERE created_at < now() - interval '365 days';        GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('audit_log', n);
  DELETE FROM public.ai_batch WHERE state IN ('ended', 'failed') AND coalesce(ended_at, created_at) < now() - interval '30 days';
                                                                                        GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('ai_batch', n);
  DELETE FROM public.message_ledger WHERE state = 'skipped' AND updated_at < now() - interval '30 days';
                                                                                        GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('ledger_skipped', n);
  DELETE FROM public.sync_run WHERE started_at < now() - interval '30 days';          GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('sync_run', n);
  DELETE FROM public.render_request WHERE state IN ('done', 'failed') AND updated_at < now() - interval '7 days';
                                                                                        GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('render_request', n);
  DELETE FROM public.session WHERE expires_at < now();                                GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('session', n);
  DELETE FROM public.verification WHERE expires_at < now();                           GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('verification', n);
  DELETE FROM public.sandbox_metered WHERE metered_at < now() - interval '14 days';   GET DIAGNOSTICS n = ROW_COUNT; r := r || jsonb_build_object('sandbox_metered', n);
  RETURN r;
END $$;
