# @edf/db — implementation decisions

Where the spec (DATA-MODEL.md, FREE-TIER.md §10) was ambiguous or silent, we chose the reading
that keeps tenants apart and can't overspend. The SQL migrations are the source of truth. Each
entry names the spec section and the reason.

## Statement timeout (Neon pooler)

- `statement_timeout` is **never a connection startup parameter**: Neon's pooled endpoint
  (PgBouncer) drops or rejects those. It is set two ways instead:
  - as `app_rw`'s default in this database (`ALTER ROLE app_rw IN DATABASE … SET
    statement_timeout = '25s'`, migration 0009). The server applies it when a session starts, so
    it works behind the pooler and also covers queries that don't go through `withUser` /
    `withSystem` (Better Auth, boot checks, purge);
  - per transaction in `inTransaction`, with `set_config('statement_timeout', '25s', true)` next
    to `app.user_id` (transaction-local, as PgBouncer's transaction mode requires).
- 25 s is below the client's 30 s `query_timeout`, so the server cancels first.
- Account deletion raises it to 120 s, for its own transaction only, for the final
  `DELETE FROM "user"` (whose cascade takes whatever the purge left), with a matching per-query
  client timeout. If that still times out, the purged batches stay committed and the next attempt
  resumes from there.

## AI spend (FREE-TIER §6.5 layer 3, migration 0009)

- `reserve_llm(p_user, p_usd, p_day, p_global_cap, p_month_cap, p_day_cap)` takes the caps from
  the app (@edf/budget `llmCaps`) rather than computing them, unlike the first three-argument
  design `(p_user, p_usd, p_period)`. It still checks the tenant context and locks the global row
  first.
- `reserve_llm` and `settle_llm` reject NULL, NaN and infinite amounts and caps (such a cap would
  never reject), and `llm_budget` / `llm_budget_global` have `CHECK (… <> 'NaN')` constraints.
- `settle_llm` is bounded by the user's own day and month rows: it releases at most what the user
  still holds there, changes the global row by exactly that amount, and does nothing when those
  rows don't exist. It can never release another user's reservation.
- `ai_batch_item.reserved_day` records the day each reservation was made; `lookup_batch_item` and
  `list_batch_items` return it with `settled_usd`. The app settles an item once, with a
  `settled_usd IS NULL` guard in the same transaction as `settle_llm` and as saving the result
  (see `packages/budget/DECISIONS.md`). Existing items were backfilled with their batch's UTC
  day, or the day before when the user has a day row only then (a batch straddling midnight).
- `llm_owner_month_reserved(p_day)` returns one number, the owner's month reservations, so a
  friend's tenant context can compute the friends' split without reading any per-user row.

## AI queue and batch items (migrations 0010, 0011, 0014)

- `list_pending_classification(lim)` returns only emails of active mailboxes that are at least
  20 minutes old, with users taking turns (`row_number()` per user, then age), instead of the
  oldest pending emails of everyone. Rows the tick can't send (an inactive mailbox, a user over
  their AI cap) stay 'pending', and with the old order one user's backlog held the whole window.
  The age filter moved into the function so the tick's work check and the batch count the same
  rows.
- `ai_batch_item.email_id` is nullable, with `ON DELETE SET NULL (email_id)` instead of
  `CASCADE`: an item whose email is deleted while its batch runs must still be settled, or its
  worst-case reservation stays held for the rest of the month. Items now have their own
  `user_id` FK to `"user"` (`ON DELETE CASCADE`), so account deletion still removes them, as the
  email cascade did before.
- `ai_batch_item.injection_hit` (0014) keeps the injection pre-scan of a design-review item
  (subject + visible text), run when the batch is submitted: the visible text isn't stored, and
  the review collected later must still be capped when the body hit a pattern (DESIGN-SCORE §6).
