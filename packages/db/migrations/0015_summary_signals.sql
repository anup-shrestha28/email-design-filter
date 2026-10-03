-- 0015 · Keep the gallery's severe-problem facts after compaction (DESIGN-SCORE.md §3.2).
-- The gallery calls an email a "Bad design" for a few clearly visible problems beyond the caps:
-- text baked into images (I1), a layout that shrinks body text to a tiny size on phones (T1), and
-- marketing mail with no unsubscribe link at all (U1). Those facts live in email_analysis.checks,
-- which compaction empties after 30 days, and a verdict must never flip because detail data expired.
-- The scoring engine now also writes them to score_summary.signals (@edf/design summarySignals).
--  - summary_signals(checks) is the same extraction in SQL (raw measurements, no thresholds: the
--    gallery owns the policy). The gallery reads score_summary.signals, falling back to this over
--    the stored checks for rows scored before the engine wrote them.
--  - Compaction (pipeline maintenance.ts) saves it into score_summary before emptying checks.
--  - Rows already scored get it now, from their checks (idempotent; compacted rows without checks
--    are left alone: they had no signals to lose).

CREATE FUNCTION public.summary_signals(checks jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  WITH c AS (
    SELECT x ->> 'id' AS id, coalesce(x ->> 'status', '') AS status, x -> 'value' AS v
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(checks) = 'array' THEN checks ELSE '[]'::jsonb END) x
    WHERE jsonb_typeof(x) = 'object' AND jsonb_typeof(x -> 'value') = 'object'
  ),
  -- I1 reports the image share even when it doesn't apply (share < 0.25); T1 / U1 only when they apply.
  i1 AS (SELECT v FROM c WHERE id = 'I1' AND status <> 'not_evaluated' LIMIT 1),
  t1 AS (SELECT v FROM c WHERE id = 'T1' AND status NOT IN ('not_evaluated', 'not_applicable') LIMIT 1),
  u1 AS (SELECT v FROM c WHERE id = 'U1' AND status NOT IN ('not_evaluated', 'not_applicable') LIMIT 1)
  SELECT jsonb_build_object(
    'imgShare',     (SELECT CASE WHEN jsonb_typeof(v -> 'imgShare') = 'number' THEN v -> 'imgShare' END FROM i1),
    'legibleChars', (SELECT CASE WHEN jsonb_typeof(v -> 'legibleChars') = 'number' THEN v -> 'legibleChars' END FROM i1),
    'phoneTextPx',  (SELECT CASE WHEN jsonb_typeof(v -> 'px') = 'number' THEN v -> 'px' END FROM t1),
    'layoutK',      (SELECT CASE WHEN jsonb_typeof(v -> 'k') = 'number' THEN v -> 'k' END FROM t1),
    'unsubscribe',  (SELECT CASE WHEN v ->> 'unsubscribe' IN ('before_clip', 'after_clip', 'none')
                                 THEN v -> 'unsubscribe' END FROM u1)
  )
$$;

REVOKE ALL ON FUNCTION public.summary_signals(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summary_signals(jsonb) TO app_rw;

UPDATE email_analysis
SET score_summary = jsonb_set(score_summary, '{signals}', public.summary_signals(checks))
WHERE jsonb_typeof(score_summary) = 'object'
  AND jsonb_typeof(score_summary -> 'signals') IS DISTINCT FROM 'object'
  AND jsonb_typeof(checks) = 'array' AND jsonb_array_length(checks) > 0;
