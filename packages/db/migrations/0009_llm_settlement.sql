-- 0009 · Exact, idempotent AI spend settlement (FREE-TIER.md §6.5 layer 3).
--  - A batch item records the day its reservation was made, so it is settled against that day and
--    month (a batch can end after midnight UTC, or in the next month). lookup_batch_item and
--    list_batch_items return that day and settled_usd; the app marks an item settled
--    (`settled_usd IS NULL` guard) in the same transaction as settle_llm, so it is settled once.
--  - settle_llm releases at most what the user still holds for that day and month, and applies
--    exactly that change to the global row: it can never release another user's reservation.
--  - reserve_llm / settle_llm reject NULL, NaN and infinite amounts and caps (such a cap never rejects).
--  - llm_owner_month_reserved: the friends' equal split is taken from the global cap minus the
--    owner's reservations, which a friend's tenant context cannot read (@edf/budget llmCaps).
--  - statement_timeout is app_rw's default in this database. It is applied by the server when a
--    session starts, so it also works behind Neon's pooler and covers queries that don't go through
--    withUser/withSystem (Better Auth, boot checks, purge). inTransaction also sets it per transaction.

GRANT app_system TO CURRENT_USER WITH SET TRUE;          -- lets the migration role replace app_system's functions

ALTER TABLE ai_batch_item ADD COLUMN reserved_day date;
-- Existing items: the batch row is committed right after the reservations, so they were made on its
-- UTC day, or on the day before when they straddled midnight (the user has no day row on the batch's day).
UPDATE ai_batch_item i SET reserved_day = CASE
    WHEN NOT EXISTS (SELECT 1 FROM llm_budget l WHERE l.user_id = i.user_id AND l.scope = 'day' AND l.day = b.day)
     AND EXISTS (SELECT 1 FROM llm_budget l WHERE l.user_id = i.user_id AND l.scope = 'day' AND l.day = b.day - 1)
    THEN b.day - 1 ELSE b.day END
  FROM (SELECT id, (created_at AT TIME ZONE 'UTC')::date AS day FROM ai_batch) b WHERE b.id = i.batch_id;
ALTER TABLE ai_batch_item ALTER COLUMN reserved_day SET NOT NULL;
GRANT SELECT (reserved_day) ON ai_batch_item TO app_system;

ALTER TABLE llm_budget        ADD CONSTRAINT llm_budget_not_nan        CHECK (reserved_usd <> 'NaN');
ALTER TABLE llm_budget_global ADD CONSTRAINT llm_budget_global_not_nan CHECK (reserved_usd <> 'NaN' AND cap_usd <> 'NaN');

-- The result columns change, so these are dropped and recreated (ownership and grants below).
DROP FUNCTION public.list_batch_items(uuid);
DROP FUNCTION public.lookup_batch_item(text);

CREATE FUNCTION public.list_batch_items(p_batch_id uuid)
RETURNS TABLE (custom_id text, user_id text, email_id uuid, template_id uuid, purpose text, reserved_usd numeric,
               reserved_day date, settled_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.custom_id, i.user_id, i.email_id, i.template_id, i.purpose, i.reserved_usd, i.reserved_day, i.settled_usd
  FROM public.ai_batch_item i WHERE i.batch_id = p_batch_id ORDER BY i.custom_id
$$;

CREATE FUNCTION public.lookup_batch_item(p_custom_id text)
RETURNS TABLE (batch_id uuid, user_id text, email_id uuid, template_id uuid, purpose text, reserved_usd numeric,
               reserved_day date, settled_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT i.batch_id, i.user_id, i.email_id, i.template_id, i.purpose, i.reserved_usd, i.reserved_day, i.settled_usd
  FROM public.ai_batch_item i WHERE i.custom_id = p_custom_id
$$;

-- The owner's reservations for the month of p_day (one number, no per-user detail).
CREATE FUNCTION public.llm_owner_month_reserved(p_day date)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(sum(b.reserved_usd), 0) FROM public.llm_budget b
  JOIN public.user_settings s ON s.user_id = b.user_id
  WHERE s.role = 'owner' AND b.scope = 'month' AND b.day = date_trunc('month', p_day)::date
$$;

-- Same body as 0004, with NULL/NaN/infinite amounts and caps rejected. Replacing keeps the owner (app_system) and grants.
CREATE OR REPLACE FUNCTION public.reserve_llm(p_user text, p_usd numeric, p_day date,
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
  IF p_usd IS NULL OR p_day IS NULL OR p_global_cap IS NULL OR p_month_cap IS NULL OR p_day_cap IS NULL
     OR 'NaN' IN (p_usd, p_global_cap, p_month_cap, p_day_cap) OR 'Infinity' IN (p_global_cap, p_month_cap, p_day_cap)
     OR p_usd <= 0 OR p_usd > 10 OR p_global_cap < 0 OR p_month_cap < 0 OR p_day_cap < 0 THEN
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

-- Settle a reservation made on p_day from actual `usage` (or release it entirely with p_actual = 0).
-- A release is bounded by what this user still holds on that day and in that month, and the global
-- row changes by exactly the amount applied to the user's rows. Same lock order as reserve_llm.
CREATE OR REPLACE FUNCTION public.settle_llm(p_user text, p_reserved numeric, p_actual numeric, p_day date)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_period date := date_trunc('month', p_day)::date;
  v_month numeric; v_day numeric; v_delta numeric;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM NULLIF(current_setting('app.user_id', true), '') THEN
    RAISE EXCEPTION 'settle_llm: tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_reserved IS NULL OR p_actual IS NULL OR p_day IS NULL OR 'NaN' IN (p_reserved, p_actual)
     OR p_reserved < 0 OR p_reserved > 10 OR p_actual < 0 OR p_actual > 10 THEN
    RAISE EXCEPTION 'settle_llm: invalid amount' USING ERRCODE = '22023';
  END IF;
  IF p_actual = p_reserved THEN RETURN; END IF;

  PERFORM 1 FROM public.llm_budget_global WHERE period = v_period FOR UPDATE;
  SELECT reserved_usd INTO v_month FROM public.llm_budget
    WHERE user_id = p_user AND scope = 'month' AND day = v_period FOR UPDATE;
  SELECT reserved_usd INTO v_day FROM public.llm_budget
    WHERE user_id = p_user AND scope = 'day' AND day = p_day FOR UPDATE;
  IF v_month IS NULL OR v_day IS NULL THEN RETURN; END IF;   -- this user reserved nothing on that day

  v_delta := greatest(p_actual - p_reserved, -least(v_month, v_day));
  IF v_delta = 0 THEN RETURN; END IF;
  UPDATE public.llm_budget_global SET reserved_usd = greatest(0, reserved_usd + v_delta) WHERE period = v_period;
  UPDATE public.llm_budget SET reserved_usd = reserved_usd + v_delta
    WHERE user_id = p_user AND ((scope = 'month' AND day = v_period) OR (scope = 'day' AND day = p_day));
END $$;

GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.list_batch_items(uuid) OWNER TO app_system;
ALTER FUNCTION public.lookup_batch_item(text) OWNER TO app_system;
ALTER FUNCTION public.llm_owner_month_reserved(date) OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.list_batch_items(uuid), public.lookup_batch_item(text),
  public.llm_owner_month_reserved(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_batch_items(uuid), public.lookup_batch_item(text),
  public.llm_owner_month_reserved(date) TO app_rw;

-- Below the client's 30 s query_timeout, so the server cancels first (same value as inTransaction).
DO $$ BEGIN
  EXECUTE format('ALTER ROLE app_rw IN DATABASE %I SET statement_timeout = %L', current_database(), '25s');
END $$;
