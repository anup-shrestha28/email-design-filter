-- 0018 · Boards: a user's own collections of saved designs ("Save" on a gallery card, Pinterest
-- style). Private to their owner like every tenant table (RLS below); a friend never sees yours.
--  - board: a named collection (names are unique per user, ignoring case).
--  - board_item: one saved design in one board. It goes with its email (deleted in Gmail, the
--    mailbox disconnected, the account deleted) and with its board.

CREATE TABLE board (
  id                      uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name                    text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX board_user_name ON board (user_id, lower(name));

CREATE TABLE board_item (
  board_id                uuid NOT NULL,
  user_id                 text NOT NULL,
  email_id                uuid NOT NULL,
  added_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, email_id),
  FOREIGN KEY (board_id, user_id) REFERENCES board (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE CASCADE
);
-- The cascade from email (purges delete thousands of emails at a time) and the gallery's "saved" mark.
CREATE INDEX board_item_email ON board_item (email_id);
CREATE INDEX board_item_user ON board_item (user_id, board_id, added_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON board, board_item TO app_rw;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['board','board_item']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I TO app_rw
      USING      (user_id = NULLIF(current_setting('app.user_id', true), ''))
      WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''))$p$, t);
  END LOOP;
END $$;
