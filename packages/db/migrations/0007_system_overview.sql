-- The owner's System page (FREE-TIER.md §8.3): aggregate, content-free counts across all tenants.
-- Returns numbers only — never addresses, ids or any per-user detail. Owner only (checked inside, like add_invite).

CREATE FUNCTION public.system_overview()
RETURNS TABLE (users int, mailboxes_total int, mailboxes_active int, mailboxes_needs_reauth int,
               mailboxes_backfilling int, ledger_failed bigint, ledger_pending bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT public.caller_is_owner() THEN RAISE EXCEPTION 'system_overview: owner only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT
    (SELECT count(*)::int FROM public.user_settings),
    (SELECT count(*)::int FROM public.mailbox),
    (SELECT count(*)::int FROM public.mailbox m WHERE m.status = 'active'),
    (SELECT count(*)::int FROM public.mailbox m WHERE m.status = 'needs_reauth'),
    (SELECT count(*)::int FROM public.mailbox m WHERE m.status = 'active' AND m.backfill_state IN ('pending', 'running')),
    (SELECT count(*) FROM public.message_ledger l WHERE l.state = 'failed'),
    (SELECT count(*) FROM public.message_ledger l WHERE l.state IN ('pending', 'pending_full'));
END
$$;

-- raiseAlert() re-notifies each code at most every 6 h and records the times in this row (it only
-- UPDATEs, so the row must exist).
INSERT INTO app_setting (key, value) VALUES ('alerts.sent', '{}') ON CONFLICT (key) DO NOTHING;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.system_overview() OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.system_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.system_overview() TO app_rw;
