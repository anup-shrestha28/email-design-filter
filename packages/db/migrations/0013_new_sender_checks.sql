-- 0013 · The new-sender check runs after the import has DRAINED (DESIGN.md §5.4 step 4; FREE-TIER.md §4.5).
-- It used to run as soon as the Q1/Q2 listing ended. Listing only writes ledger rows; sender rows
-- are created later, when the drain stores each message (≈ 8 min for a friend's 30 days, 25–30 min
-- for the owner's 90). So the check saw almost none of the imported senders, and those created
-- afterwards kept seen_before_window NULL, which the UI shows as "New senders" for up to 14 days.
-- The listing now leaves `newSendersBefore` (the window start, epoch seconds) in backfill_progress;
-- the tick lists mailboxes whose import is done with no backfill row still pending, and the check
-- clears the mark once every candidate sender has been looked at.

-- The definer function reads the mark (backfill_progress holds counts, the window and timestamps only).
GRANT SELECT (backfill_progress) ON mailbox TO app_system;

CREATE FUNCTION public.list_new_sender_checks(lim int)
RETURNS TABLE (mailbox_id uuid, user_id text, before_epoch bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT m.id, m.user_id, (m.backfill_progress->>'newSendersBefore')::bigint
  FROM public.mailbox m
  WHERE m.status = 'active' AND m.backfill_state = 'done'
    AND (m.backfill_progress->>'newSendersBefore') ~ '^[0-9]{1,12}$'
    AND NOT EXISTS (SELECT 1 FROM public.message_ledger l
                    WHERE l.mailbox_id = m.id AND l.source = 'backfill' AND l.state IN ('pending', 'pending_full'))
  ORDER BY m.created_at, m.id
  LIMIT least(greatest(lim, 1), 100)
$$;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.list_new_sender_checks(int) OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.list_new_sender_checks(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_new_sender_checks(int) TO app_rw;
