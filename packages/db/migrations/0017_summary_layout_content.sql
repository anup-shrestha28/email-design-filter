-- 0017 · Keep each email's visible content extent, so its gallery card crops to the whole design.
-- The gallery card shows the top of each email, zoomed to a horizontal slice of the 800 px render.
-- The slice came from the analysis' "main container", which a browser audit of the owner's real
-- mail showed often misses the design (an inner block, a footer scrap), trimming designs at the
-- edges and leaving narrow ones small in their card. The renderer (render-2026.3) now measures the
-- extent of everything a reader can see (features.render.layout.content: left / right / bottom in
-- desktop CSS px; JSON null when it found nothing visible; absent on older renders), and the
-- scoring engine copies it, with the desktop document width, into score_summary.layout
-- (@edf/design summaryLayout), which compaction keeps.
--  - summary_layout(features) now also returns them: `content` only when it is an object with
--    numeric left / right / bottom (JSON null when the render recorded null; the key absent when
--    the render has none), and `desktopContentWidth` when it is a number. Unchanged otherwise
--    (still null without a render).
--  - Compaction (pipeline maintenance.ts) fills the keys an older summary layout lacks from the
--    features before emptying them, so an extent is never lost.
--  - Rows already scored get the missing keys now, from their features (idempotent; the keys
--    already in a summary layout are kept; compacted rows without features are left alone).

CREATE OR REPLACE FUNCTION public.summary_layout(features jsonb)
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
    || CASE
         WHEN jsonb_typeof(features #> '{render,layout,desktopContentWidth}') = 'number'
         THEN jsonb_build_object('desktopContentWidth', features #> '{render,layout,desktopContentWidth}')
         ELSE '{}'::jsonb END
    || CASE
         WHEN jsonb_typeof(features #> '{render,layout,content}') = 'null'
         THEN jsonb_build_object('content', 'null'::jsonb)
         WHEN jsonb_typeof(features #> '{render,layout,content}') = 'object'
          AND jsonb_typeof(features #> '{render,layout,content,left}') = 'number'
          AND jsonb_typeof(features #> '{render,layout,content,right}') = 'number'
          AND jsonb_typeof(features #> '{render,layout,content,bottom}') = 'number'
         THEN jsonb_build_object('content', jsonb_build_object(
           'left',   features #> '{render,layout,content,left}',
           'right',  features #> '{render,layout,content,right}',
           'bottom', features #> '{render,layout,content,bottom}'))
         ELSE '{}'::jsonb END
  END
$$;

REVOKE ALL ON FUNCTION public.summary_layout(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.summary_layout(jsonb) TO app_rw;

-- The features' layout fills only what the summary layout lacks (a summary written by the engine
-- and its features always agree; the summary's own values win).
UPDATE email_analysis
SET score_summary = jsonb_set(
      score_summary, '{layout}',
      public.summary_layout(features)
        || CASE WHEN jsonb_typeof(score_summary -> 'layout') = 'object'
                THEN score_summary -> 'layout' ELSE '{}'::jsonb END)
WHERE jsonb_typeof(score_summary) = 'object'
  AND public.summary_layout(features) IS NOT NULL
  AND (jsonb_typeof(score_summary -> 'layout') IS DISTINCT FROM 'object'
       OR (public.summary_layout(features) ? 'content' AND NOT (score_summary -> 'layout') ? 'content')
       OR (public.summary_layout(features) ? 'desktopContentWidth'
           AND NOT (score_summary -> 'layout') ? 'desktopContentWidth'));
