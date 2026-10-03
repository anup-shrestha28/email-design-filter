-- 0014 · The injection pre-scan of a batched design review covers the visible text (DESIGN-SCORE.md §6).
-- The subject and visible text are pre-scanned for injection patterns; a hit caps every AI level
-- at the corpus median. A real-time review scans both. A batched review (template samples) only
-- re-scanned the subject when its result was collected: the visible text isn't stored, so a body
-- injection sent to the model was never capped, and the review was reused for the whole template.
-- The pre-scan now runs when the batch is submitted (subject + visible text) and its result is
-- kept on the item, written in the same transaction as the reservation; collection reads it.
-- Items written before this migration (and classification items) default to false; collection
-- still re-scans the subject for them.

ALTER TABLE ai_batch_item ADD COLUMN injection_hit boolean NOT NULL DEFAULT false;
