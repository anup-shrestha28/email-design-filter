-- 0010 · Fair AI classification queue (FREE-TIER.md §4.2 step "ai", §6.1).
-- list_pending_classification returned the oldest pending emails across all users. Rows the tick
-- can't send (a mailbox that isn't active, a user over their AI cap) stay 'pending', so once one
-- user had a large backlog they held the whole window and nobody else's mail was classified.
--  - Only emails of active mailboxes are returned (the tick skips the others anyway).
--  - Users take turns: each user's oldest row first, then each user's second-oldest, and so on
--    (row_number() per user), so one user's backlog can't crowd out everyone else.
--  - Rows younger than 20 minutes are left out here (the rules may still settle them), so the
--    tick's work check and the batch both count the same rows.
-- Same signature and result columns: replacing keeps the owner (app_system) and grants.

GRANT app_system TO CURRENT_USER WITH SET TRUE;          -- lets the migration role replace app_system's functions

CREATE OR REPLACE FUNCTION public.list_pending_classification(lim int)
RETURNS TABLE (email_id uuid, user_id text, mailbox_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.id, p.user_id, p.mailbox_id, p.created_at FROM (
    SELECT e.id, e.user_id, e.mailbox_id, e.created_at,
           row_number() OVER (PARTITION BY e.user_id ORDER BY e.created_at, e.id) AS turn
    FROM public.email e JOIN public.mailbox m ON m.id = e.mailbox_id
    WHERE e.type_source = 'pending' AND m.status = 'active' AND e.created_at < now() - interval '20 minutes'
  ) p
  ORDER BY p.turn, p.created_at, p.id LIMIT least(greatest(lim, 1), 500)
$$;
