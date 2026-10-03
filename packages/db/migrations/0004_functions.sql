-- 0004 · SECURITY DEFINER functions (DATA-MODEL.md §4.3, FREE-TIER.md §10).
-- Owned by app_system (never BYPASSRLS), `SET search_path = pg_catalog, pg_temp` (search
-- functions also need public for operators), EXECUTE granted to app_rw only. Cross-tenant
-- functions return minimal columns; each returned row is then processed under withUser().

-- ───────────────────────── kept for schema identity (paid edition; never called here) ─────────────────────────
CREATE FUNCTION public.lookup_mailbox_for_push(p_email text)
RETURNS TABLE (mailbox_id uuid, user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id FROM public.mailbox m
  WHERE m.provider = 'gmail'
    AND m.email_address OPERATOR(public.=) p_email::public.citext   -- citext's case-insensitive = (not on the search_path)
    AND m.status IN ('active', 'needs_reauth')
$$;

CREATE FUNCTION public.list_mailboxes_due_for_watch(p_before timestamptz, lim int)
RETURNS TABLE (mailbox_id uuid, user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id FROM public.mailbox m
  WHERE m.status = 'active' AND m.watch_expires_at < p_before
  ORDER BY m.watch_expires_at LIMIT least(lim, 500)
$$;

-- ───────────────────────── tenant-scoped search (explicit tenant predicate → full GIN index use) ─────────────────────────
-- `q` goes through websearch_to_tsquery; `prefix` (the last token, already reduced to letters/digits by the
-- app) is ANDed as a prefix match for search-as-you-type.
CREATE FUNCTION public.search_emails(q text, prefix text DEFAULT '', lim int DEFAULT 50)
RETURNS TABLE (id uuid, rank real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH query AS (
    SELECT CASE
      WHEN coalesce(prefix, '') = '' THEN websearch_to_tsquery('simple', coalesce(q, ''))
      WHEN coalesce(q, '') = ''      THEN to_tsquery('simple', quote_literal(prefix) || ':*')
      ELSE websearch_to_tsquery('simple', q) && to_tsquery('simple', quote_literal(prefix) || ':*')
    END AS tsq
  )
  SELECT e.id, ts_rank_cd(e.search_tsv, query.tsq)
  FROM public.email e, query
  WHERE e.user_id = NULLIF(current_setting('app.user_id', true), '')
    AND e.search_tsv @@ query.tsq
    AND NOT e.is_hidden
  ORDER BY 2 DESC, e.received_at DESC LIMIT least(greatest(lim, 1), 200)
$$;

CREATE FUNCTION public.search_senders(q text, lim int DEFAULT 20)
RETURNS TABLE (id uuid, similarity real)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, greatest(similarity(coalesce(s.display_name, ''), q), similarity(s.address::text, q))
  FROM public.sender s
  WHERE s.user_id = NULLIF(current_setting('app.user_id', true), '')
    AND (coalesce(s.display_name, '') % q OR s.display_name ILIKE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR s.address::text ILIKE '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%')
  ORDER BY 2 DESC, s.email_count DESC LIMIT least(greatest(lim, 1), 50)
$$;

-- ───────────────────────── sync & drain (FREE-TIER §4.2, §4.6) ─────────────────────────
CREATE FUNCTION public.list_mailboxes_due_for_poll(lim int)
RETURNS TABLE (mailbox_id uuid, user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id FROM public.mailbox m
  WHERE m.status = 'active'
    AND (m.next_poll_at IS NULL OR m.next_poll_at <= now() OR m.poll_incomplete)
    AND (m.sync_lease_until IS NULL OR m.sync_lease_until < now())
  ORDER BY m.poll_incomplete DESC, m.next_poll_at ASC NULLS FIRST
  LIMIT least(greatest(lim, 1), 500)
$$;

-- Eligible = pending on an active mailbox, attempt time reached (NULL = never attempted), excluding rows
-- of backfills that are still queued (not admitted). Shared by the count and the batch below.
CREATE FUNCTION public.count_drain_eligible()
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT count(*) FROM public.message_ledger l JOIN public.mailbox m ON m.id = l.mailbox_id
  WHERE l.state IN ('pending', 'pending_full')
    AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= now())
    AND m.status = 'active'
    AND NOT (l.source = 'backfill' AND m.backfill_state = 'pending')
$$;

-- Round-robin across mailboxes, new-mail rows before backfill rows; backfill rows in list order
-- (slices are listed newest-first; larger Gmail ids are newer within a page).
CREATE FUNCTION public.list_drain_batch(lim int)
RETURNS TABLE (mailbox_id uuid, user_id text, provider_message_id text, state text, source text, attempts smallint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.mailbox_id, t.user_id, t.provider_message_id, t.state, t.source, t.attempts FROM (
    SELECT l.mailbox_id, l.user_id, l.provider_message_id, l.state, l.source, l.attempts,
           (l.source = 'backfill') AS is_backfill,
           row_number() OVER (PARTITION BY l.mailbox_id, (l.source = 'backfill')
                              ORDER BY l.created_at ASC, l.provider_message_id DESC) AS rn
    FROM public.message_ledger l JOIN public.mailbox m ON m.id = l.mailbox_id
    WHERE l.state IN ('pending', 'pending_full')
      AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= now())
      AND m.status = 'active'
      AND NOT (l.source = 'backfill' AND m.backfill_state = 'pending')
  ) t
  ORDER BY t.is_backfill, t.rn, t.mailbox_id
  LIMIT least(greatest(lim, 1), 2000)
$$;

-- Backfill admission queue (FIFO; one runs at a time — FREE-TIER §4.5).
CREATE FUNCTION public.list_backfill_queue(lim int)
RETURNS TABLE (mailbox_id uuid, user_id text, backfill_state text, requested_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id, m.backfill_state, m.backfill_requested_at FROM public.mailbox m
  WHERE m.status = 'active' AND m.backfill_state IN ('pending', 'running')
  ORDER BY (m.backfill_state = 'running') DESC, m.backfill_requested_at ASC NULLS LAST, m.created_at ASC
  LIMIT least(greatest(lim, 1), 100)
$$;

-- Mailboxes the maintenance job must act on: needs_reauth for 30+ days, or a disconnect to finish.
CREATE FUNCTION public.list_mailboxes_for_purge(lim int)
RETURNS TABLE (mailbox_id uuid, user_id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id, m.status FROM public.mailbox m
  WHERE m.status = 'disconnecting'
     OR (m.status = 'needs_reauth' AND m.needs_reauth_since < now() - interval '30 days')
  ORDER BY m.created_at LIMIT least(greatest(lim, 1), 100)
$$;

-- Emails whose time-bound importance boost has lapsed (materialised in the tick; FREE-TIER §4.2).
CREATE FUNCTION public.list_importance_expired(lim int)
RETURNS TABLE (email_id uuid, user_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id, e.user_id FROM public.email e
  WHERE e.importance_expires_at <= now()
  ORDER BY e.importance_expires_at LIMIT least(greatest(lim, 1), 1000)
$$;

-- ───────────────────────── users, render, AI ─────────────────────────
CREATE FUNCTION public.list_active_users()
RETURNS TABLE (user_id text, role text, last_active_at timestamptz, backfill_window_days int, mailboxes int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT us.user_id, us.role, us.last_active_at, us.backfill_window_days,
         (SELECT count(*)::int FROM public.mailbox m WHERE m.user_id = us.user_id AND m.status = 'active')
  FROM public.user_settings us
  ORDER BY us.role = 'owner' DESC, us.user_id
$$;

CREATE FUNCTION public.list_render_due(lim int)
RETURNS TABLE (user_id text, queued_count bigint, on_demand_count bigint, oldest_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.user_id, count(*), count(*) FILTER (WHERE r.kind = 'on_demand'), min(r.requested_at)
  FROM public.render_request r
  WHERE r.state = 'queued'
  GROUP BY r.user_id
  ORDER BY count(*) FILTER (WHERE r.kind = 'on_demand') DESC, min(r.requested_at)
  LIMIT least(greatest(lim, 1), 100)
$$;

-- /api/view-source has no session: after the OIDC caller check it looks up the owner, then verifies the
-- HMAC view token against it (the HMAC covers userId, which is not in the URL). Result used only if it verifies.
CREATE FUNCTION public.lookup_email_owner(p_email_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.user_id FROM public.email e WHERE e.id = p_email_id
$$;

CREATE FUNCTION public.list_batch_items(p_batch_id uuid)
RETURNS TABLE (custom_id text, user_id text, email_id uuid, template_id uuid, purpose text, reserved_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.custom_id, i.user_id, i.email_id, i.template_id, i.purpose, i.reserved_usd
  FROM public.ai_batch_item i WHERE i.batch_id = p_batch_id ORDER BY i.custom_id
$$;

CREATE FUNCTION public.lookup_batch_item(p_custom_id text)
RETURNS TABLE (batch_id uuid, user_id text, email_id uuid, template_id uuid, purpose text, reserved_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.batch_id, i.user_id, i.email_id, i.template_id, i.purpose, i.reserved_usd
  FROM public.ai_batch_item i WHERE i.custom_id = p_custom_id
$$;

-- Atomic AI spend reservation (FREE-TIER §6.5 layer 3). Locks the global month row first, then the
-- user's month and day rows (fixed order → no deadlocks). Must run inside the user's tenant context.
CREATE FUNCTION public.reserve_llm(p_user text, p_usd numeric, p_day date,
                                   p_global_cap numeric, p_month_cap numeric, p_day_cap numeric)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_period date := date_trunc('month', p_day)::date;
  v_global numeric; v_cap numeric; v_month numeric; v_day numeric;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'reserve_llm: tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_usd IS NULL OR p_usd <= 0 OR p_usd > 10 OR p_global_cap < 0 OR p_month_cap < 0 OR p_day_cap < 0 THEN
    RAISE EXCEPTION 'reserve_llm: invalid amount' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.llm_budget_global (period, reserved_usd, cap_usd) VALUES (v_period, 0, p_global_cap)
    ON CONFLICT (period) DO UPDATE SET cap_usd = EXCLUDED.cap_usd;
  SELECT reserved_usd, cap_usd INTO v_global, v_cap FROM public.llm_budget_global
    WHERE period = v_period FOR UPDATE;

  INSERT INTO public.llm_budget (user_id, scope, day) VALUES (p_user, 'month', v_period), (p_user, 'day', p_day)
    ON CONFLICT DO NOTHING;
  SELECT reserved_usd INTO v_month FROM public.llm_budget
    WHERE user_id = p_user AND scope = 'month' AND day = v_period FOR UPDATE;
  SELECT reserved_usd INTO v_day FROM public.llm_budget
    WHERE user_id = p_user AND scope = 'day' AND day = p_day FOR UPDATE;

  IF v_global + p_usd > v_cap OR v_month + p_usd > p_month_cap OR v_day + p_usd > p_day_cap THEN
    RETURN false;
  END IF;

  UPDATE public.llm_budget_global SET reserved_usd = reserved_usd + p_usd WHERE period = v_period;
  UPDATE public.llm_budget SET reserved_usd = reserved_usd + p_usd
    WHERE user_id = p_user AND ((scope = 'month' AND day = v_period) OR (scope = 'day' AND day = p_day));
  RETURN true;
END $$;

-- Settle a reservation from actual `usage` (or release it entirely with p_actual = 0).
CREATE FUNCTION public.settle_llm(p_user text, p_reserved numeric, p_actual numeric, p_day date)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_period date := date_trunc('month', p_day)::date;
  v_delta numeric := coalesce(p_actual, 0) - coalesce(p_reserved, 0);
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'settle_llm: tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_reserved < 0 OR p_actual < 0 OR p_actual > 10 THEN
    RAISE EXCEPTION 'settle_llm: invalid amount' USING ERRCODE = '22023';
  END IF;
  IF v_delta = 0 THEN RETURN; END IF;
  UPDATE public.llm_budget_global SET reserved_usd = greatest(0, reserved_usd + v_delta) WHERE period = v_period;
  UPDATE public.llm_budget SET reserved_usd = greatest(0, reserved_usd + v_delta)
    WHERE user_id = p_user AND ((scope = 'month' AND day = v_period) OR (scope = 'day' AND day = p_day));
END $$;

-- ───────────────────────── metering & retention (FREE-TIER §8.1, §10) ─────────────────────────
CREATE FUNCTION public.add_usage(p_day date, p_resource text, p_amount numeric)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_amount IS NULL OR p_amount < 0 OR p_amount > 1e9 THEN
    RAISE EXCEPTION 'add_usage: invalid amount' USING ERRCODE = '22023';
  END IF;
  IF p_amount = 0 THEN RETURN; END IF;
  INSERT INTO public.usage_ledger AS u (day, resource, amount) VALUES (p_day, p_resource, p_amount)
    ON CONFLICT (day, resource) DO UPDATE SET amount = u.amount + EXCLUDED.amount, updated_at = now();
END $$;

CREATE FUNCTION public.purge_system_rows()
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
  RETURN r;
END $$;

-- ───────────────────────── invite gate (beta_allowlist is not readable by app_rw) ─────────────────────────
CREATE FUNCTION public.is_invited(p_email text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT b.role FROM public.beta_allowlist b WHERE b.email OPERATOR(public.=) p_email::public.citext
$$;

CREATE FUNCTION public.claim_invite(p_email text)
RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE public.beta_allowlist b SET used_at = coalesce(b.used_at, now())
  WHERE b.email OPERATOR(public.=) p_email::public.citext
  RETURNING b.role
$$;

-- Owner-only management: the caller's tenant context must be an owner.
CREATE FUNCTION public.caller_is_owner()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_settings us
                 WHERE us.user_id = NULLIF(current_setting('app.user_id', true), '') AND us.role = 'owner')
$$;

CREATE FUNCTION public.add_invite(p_email text, p_role text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT public.caller_is_owner() THEN RAISE EXCEPTION 'add_invite: owner only' USING ERRCODE = '42501'; END IF;
  IF p_role NOT IN ('friend') THEN RAISE EXCEPTION 'add_invite: invalid role' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.beta_allowlist (email, role, invited_by)
    VALUES (p_email::public.citext, p_role, NULLIF(current_setting('app.user_id', true), ''))
    ON CONFLICT (email) DO NOTHING;
END $$;

CREATE FUNCTION public.remove_invite(p_email text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE n int;
BEGIN
  IF NOT public.caller_is_owner() THEN RAISE EXCEPTION 'remove_invite: owner only' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.beta_allowlist b WHERE b.email OPERATOR(public.=) p_email::public.citext AND b.role = 'friend';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

CREATE FUNCTION public.list_invites()
RETURNS TABLE (email text, role text, created_at timestamptz, used_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT public.caller_is_owner() THEN RAISE EXCEPTION 'list_invites: owner only' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT b.email::text, b.role, b.created_at, b.used_at FROM public.beta_allowlist b ORDER BY b.created_at;
END $$;

-- ───────────────────────── ownership & grants ─────────────────────────
GRANT app_system TO CURRENT_USER WITH SET TRUE;          -- lets the migration role assign function ownership
GRANT CREATE ON SCHEMA public TO app_system;             -- required only while changing ownership …
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_system', f);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM app_system;          -- … and revoked immediately after

GRANT EXECUTE ON FUNCTION
  public.search_emails(text, text, int),
  public.search_senders(text, int),
  public.list_mailboxes_due_for_poll(int),
  public.count_drain_eligible(),
  public.list_drain_batch(int),
  public.list_backfill_queue(int),
  public.list_mailboxes_for_purge(int),
  public.list_importance_expired(int),
  public.list_active_users(),
  public.list_render_due(int),
  public.lookup_email_owner(uuid),
  public.list_batch_items(uuid),
  public.lookup_batch_item(text),
  public.reserve_llm(text, numeric, date, numeric, numeric, numeric),
  public.settle_llm(text, numeric, numeric, date),
  public.add_usage(date, text, numeric),
  public.purge_system_rows(),
  public.is_invited(text),
  public.claim_invite(text),
  public.caller_is_owner(),
  public.add_invite(text, text),
  public.remove_invite(text),
  public.list_invites(),
  public.lookup_mailbox_for_push(text),
  public.list_mailboxes_due_for_watch(timestamptz, int)
TO app_rw;
