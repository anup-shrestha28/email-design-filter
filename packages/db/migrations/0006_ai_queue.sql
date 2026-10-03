-- 0006 · AI classification queue (FREE-TIER.md §4.2 step "ai", §6.1): emails the rules couldn't
-- settle (type_source = 'pending') are classified in Message Batches from the tick. The tick needs a
-- cross-tenant view of that queue; rows are then processed under withUser(user_id).

CREATE INDEX email_pending_classification ON email (created_at) WHERE type_source = 'pending';

GRANT SELECT (type_source, created_at, mailbox_id) ON email TO app_system;

CREATE FUNCTION public.list_pending_classification(lim int)
RETURNS TABLE (email_id uuid, user_id text, mailbox_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.id, e.user_id, e.mailbox_id, e.created_at FROM public.email e
  WHERE e.type_source = 'pending'
  ORDER BY e.created_at LIMIT least(greatest(lim, 1), 500)
$$;

-- Connect flow (DESIGN.md §4.3 conflict rule): which account currently holds a Google account binding.
GRANT SELECT (provider_account_id) ON mailbox TO app_system;

CREATE FUNCTION public.lookup_mailbox_binding(p_sub text)
RETURNS TABLE (mailbox_id uuid, user_id text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id, m.status FROM public.mailbox m
  WHERE m.provider = 'gmail' AND m.provider_account_id = p_sub
$$;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.list_pending_classification(int) OWNER TO app_system;
ALTER FUNCTION public.lookup_mailbox_binding(text) OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.list_pending_classification(int), public.lookup_mailbox_binding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_pending_classification(int), public.lookup_mailbox_binding(text) TO app_rw;
