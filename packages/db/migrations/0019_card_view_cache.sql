-- 0019 · Saved gallery cards (2026-10-08). A gallery card is the email rebuilt for edf-view: fetched
-- from Gmail, parsed and sanitized, its images signed. That was redone on every gallery visit and
-- was edf-app's biggest Active CPU cost (a CPU L2 then turned the gallery's pictures off). The
-- finished card is kept here and reused while its key matches (apps/web server/view-source.ts
-- cardCacheKey: the deployed code, the image tokens' week, and every input the card depends on).
-- One row per email; private to its owner like every tenant table (RLS below); it goes with its
-- email. Rows older than 8 days (past a week's image tokens) are pruned daily
-- (prune_card_view_cache) and whenever their owner saves a new card.

CREATE TABLE card_view_cache (
  email_id            uuid NOT NULL,
  user_id             text NOT NULL,
  cache_key           text NOT NULL CHECK (char_length(cache_key) BETWEEN 1 AND 128),
  html                text NOT NULL,
  height              integer NOT NULL,
  image_bytes_minted  bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (email_id, user_id),
  FOREIGN KEY (email_id, user_id) REFERENCES email (id, user_id) ON DELETE CASCADE
);
CREATE INDEX card_view_cache_user_created ON card_view_cache (user_id, created_at);
CREATE INDEX card_view_cache_created ON card_view_cache (created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON card_view_cache TO app_rw;

ALTER TABLE card_view_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_view_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON card_view_cache TO app_rw
  USING      (user_id = NULLIF(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), ''));

-- The daily prune runs as app_system (no tenant context): only the age column, only deletes.
GRANT SELECT (email_id, user_id, created_at) ON card_view_cache TO app_system;
GRANT DELETE ON card_view_cache TO app_system;
CREATE POLICY system_read  ON card_view_cache FOR SELECT TO app_system USING (true);
CREATE POLICY system_purge ON card_view_cache FOR DELETE TO app_system USING (true);

CREATE FUNCTION public.prune_card_view_cache()
RETURNS integer
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH d AS (
    DELETE FROM public.card_view_cache WHERE created_at < now() - interval '8 days' RETURNING 1
  )
  SELECT count(*)::integer FROM d
$$;

GRANT app_system TO CURRENT_USER WITH SET TRUE;
GRANT CREATE ON SCHEMA public TO app_system;
ALTER FUNCTION public.prune_card_view_cache() OWNER TO app_system;
REVOKE CREATE ON SCHEMA public FROM app_system;
REVOKE ALL ON FUNCTION public.prune_card_view_cache() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prune_card_view_cache() TO app_rw;

-- The daily picture check's last result (apps/web server/picture-health.ts); the owner sees a
-- banner while it reports a problem.
INSERT INTO app_setting (key, value) VALUES ('picture_health', '{"ok":true,"checkedAt":null,"checked":0,"problems":[]}')
  ON CONFLICT (key) DO NOTHING;
