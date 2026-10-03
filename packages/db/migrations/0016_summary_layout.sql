-- 0016 · Keep each email's rendered size after compaction, so the gallery can show it full length.
-- The gallery shows every email design top to bottom, sized from the render's layout facts
-- (features.render.layout: document height at the 800 px desktop and 375 px phone viewports, the
-- phone content width, and the main container). Its viewer iframe is script-free, so it can't
-- measure the email itself. Those facts live in email_analysis.features, which compaction empties
-- after 30 days.
-- The scoring engine now also writes them to score_summary.layout (@edf/design summaryLayout).
--  - summary_layout(features) is the same extraction in SQL (null when the email has no render).
--  - Compaction (pipeline maintenance.ts) saves it into score_summary before emptying features.
--  - Rows already scored get it now, from their features (idempotent; compacted rows without
--    features are left alone: the gallery shows them with the fixed-size preview, as before).

CREATE FUNCTION public.summary_layout(features jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN jsonb_typeof(features #> '{render,layout}') = 'object'
     AND jsonb_typeof(features #> '{render,layout,desktopHeight}') = 'number'
     AND jsonb_typeof(features #> '{render,layout,mobileHeight}') = 'number'
     AND jsonb_typeof(features #> '{render,layout,mobileContentWidth}') = 'number'
    THEN jsonb_build_object(
      'desktopHeight',      features #> '{render,layout,desktopHeight}',
      'mobileHeight',       features #> '{render,layout,mobileHeight}',
      'mobileContentWidth', features #> '{render,layout,mobileContentWidth}',
      'mainContainer',      CASE
        WHEN jsonb_typeof(features #> '{render,layout,mainContainer}') = 'object'
        THEN jsonb_build_object(
          'x', features #> '{render,layout,mainContainer,x}',
          'y', features #> '{render,layout,mainContainer,y}',
          'w', features #> '{render,layout,mainContainer,w}',
          'h', features #> '{render,layout,mainContainer,h}')
        ELSE 'null'::jsonb END)
  END
$$;

REVOKE ALL ON FUNCTION public.summary_layout(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summary_layout(jsonb) TO app_rw;

UPDATE email_analysis
SET score_summary = jsonb_set(score_summary, '{layout}', public.summary_layout(features))
WHERE jsonb_typeof(score_summary) = 'object'
  AND jsonb_typeof(score_summary -> 'layout') IS DISTINCT FROM 'object'
  AND public.summary_layout(features) IS NOT NULL;
