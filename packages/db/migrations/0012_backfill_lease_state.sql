-- 0012 · What the backfill lease holder is doing (FREE-TIER.md §4.5: one backfill at a time).
-- The tick used to look the leased mailbox up through list_backfill_queue and count its pending rows
-- through list_drain_batch(2000). Both hid the answer it needed:
--  - list_backfill_queue returns active mailboxes only, so a mailbox that went needs_reauth/paused
--    mid-listing looked "gone": the lease was released but backfill_state stayed 'running', and
--    once reconnected that mailbox sat at the head of the FIFO forever (nothing restarts a 'running'
--    mailbox without the lease), blocking every later import;
--  - list_drain_batch returns only rows due now (not those in retry backoff), puts every new-mail
--    row first and stops at 2000 rows, so it could count 0 while backfill rows were still pending,
--    and the lease was released early.
-- This returns the leased mailbox whatever its status, and counts its pending backfill rows directly.

CREATE FUNCTION public.backfill_lease_state(p_mailbox uuid)
RETURNS TABLE (user_id text, status text, backfill_state text, pending_rows bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.user_id, m.status, m.backfill_state,
         (SELECT count(*) FROM public.message_ledger l
          WHERE l.mailbox_id = m.id AND l.source = 'backfill' AND l.state IN ('pending', 'pending_full'))
  FROM public.mailbox m WHERE m.id = p_mailbox
$$;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.backfill_lease_state(uuid) OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.backfill_lease_state(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.backfill_lease_state(uuid) TO app_rw;
