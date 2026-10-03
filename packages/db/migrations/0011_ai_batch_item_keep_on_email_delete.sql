-- 0011 · A batch item outlives its email (FREE-TIER.md §6.5 layer 3: every item is settled once).
-- ai_batch_item used to cascade on email delete. An email deleted while its batch was running
-- (deleted in Gmail, retention, a mailbox purge, a 404 on re-fetch) took its item with it, so the
-- item was never settled and its worst-case reservation stayed held for the rest of the month.
-- Now the item stays with email_id = NULL: collection settles it (the request was still billed)
-- and skips applying the result. Items still go with their batch (30-day purge of ended/failed
-- batches) and with the user (account deletion), as they did before through the email.

ALTER TABLE ai_batch_item DROP CONSTRAINT ai_batch_item_email_id_user_id_fkey;
ALTER TABLE ai_batch_item ALTER COLUMN email_id DROP NOT NULL;
ALTER TABLE ai_batch_item
  ADD CONSTRAINT ai_batch_item_email_id_user_id_fkey
    FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE SET NULL (email_id),
  ADD CONSTRAINT ai_batch_item_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES "user" (id) ON DELETE CASCADE;
