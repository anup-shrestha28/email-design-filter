/**
 * One gallery design's stored facts for the detail view's "How we judged this" panel
 * (lib/gallery-evidence.ts): the verdict's inputs, exactly as the gallery list reads them
 * (queries/gallery.ts toGalleryItem), plus the pillar scores, the summary's explanation keys and —
 * only while they are stored — the few check values, image loads and render facts (whether "no
 * main button" is backed up) the panel quotes. Read-only.
 *
 * Only the caller's own designs, and only ones the gallery lists (never security-sensitive,
 * plain-text or hidden mail): an explicit `user_id` predicate inside withUser (RLS is the backstop),
 * so another user's id simply finds nothing.
 */
import "server-only";
import { raw, sql, withUser } from "@edf/db";
import type { DesignBand } from "@edf/design/types";
import { noButtonBackedUp, type RenderFacts } from "@/lib/gallery";
import { AI_CHECKS, type EvidenceInput, type EvidencePillar } from "@/lib/gallery-evidence";
import { getPool } from "../db";
import { baseConditions, GALLERY_SIGNALS, RENDER_FACTS } from "./gallery";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The checks the panel quotes (and the AI review's, to tell whether it ran). */
const QUOTED_CHECKS = ["A1", "H3", "H6", "I3", "M1", "M3", "M7", "X1", ...AI_CHECKS];
/** AI review states whose rating counts toward the score (email.design_ai_state). */
const AI_DONE: ReadonlySet<string> = new Set(["done", "from_template"]);

interface Row {
  design_score: number | null;
  design_band: DesignBand | null;
  design_capped: boolean | null;
  design_provisional: boolean | null;
  design_issues: string[];
  design_source: string;
  design_ai_state: string;
  primary_type: string;
  caps: string[] | null;
  coverage_confidence: number | null;
  raw_score: number | null;
  summary_raw: unknown;
  needs: unknown;
  pillar_scores: unknown;
  summary_pillars: unknown;
  signals: unknown;
  checks: Record<string, { status: unknown; value: unknown }> | null;
  loads: unknown;
  render_facts: RenderFacts | null;
  compacted: boolean;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function pillarsOf(v: unknown): EvidencePillar[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p): EvidencePillar[] => {
    if (typeof p !== "object" || p === null) return [];
    const o = p as Record<string, unknown>;
    if (typeof o.id !== "string" || !finite(o.points) || !finite(o.max)) return [];
    return [
      { id: o.id, points: o.points, max: o.max, nominal: finite(o.nominal) ? o.nominal : null },
    ];
  });
}

function needsOf(v: unknown): EvidenceInput["needs"] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((n) =>
    typeof n === "object" &&
    n !== null &&
    typeof (n as { key?: unknown }).key === "string" &&
    typeof (n as { title?: unknown }).title === "string"
      ? [{ key: (n as { key: string }).key, title: (n as { title: string }).title }]
      : [],
  );
}

/**
 * The panel's input for one of the caller's gallery designs, or null when it isn't theirs, isn't in
 * the gallery, or isn't an id.
 */
export async function galleryEvidenceInput(
  userId: string,
  emailId: string,
): Promise<EvidenceInput | null> {
  if (typeof emailId !== "string" || !UUID_RE.test(emailId)) return null;
  const pool = await getPool();
  const row = await withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<Row>(sql`
      SELECT e.design_score, e.design_band, e.design_capped, e.design_provisional, e.design_issues,
             e.design_source, e.design_ai_state, e.primary_type,
             a.caps, a.confidence::float8 AS coverage_confidence, a.raw_score::float8 AS raw_score,
             a.score_summary -> 'raw' AS summary_raw,
             a.score_summary -> 'needsImprovement' AS needs,
             a.pillar_scores, a.score_summary -> 'pillars' AS summary_pillars,
             ${GALLERY_SIGNALS} AS signals,
             (CASE WHEN jsonb_typeof(a.checks) = 'array' THEN (
               SELECT jsonb_object_agg(c ->> 'id', jsonb_build_object('status', c -> 'status', 'value', c -> 'value'))
               FROM jsonb_array_elements(a.checks) c
               WHERE c ->> 'id' = ANY(${sql`ARRAY[${sql.join(
                 QUOTED_CHECKS.map((id) => sql`${id}`),
                 sql`, `,
               )}]::text[]`})
             ) END) AS checks,
             -- Why each content image wasn't drawn (only these three fields are read).
             (CASE WHEN jsonb_typeof(a.features #> '{render,images,loads}') = 'array' THEN (
               SELECT coalesce(jsonb_agg(jsonb_build_object('status', l -> 'status', 'decoded', l -> 'decoded', 'reason', l -> 'reason')), '[]'::jsonb)
               FROM jsonb_array_elements(a.features #> '{render,images,loads}') l
             ) END) AS loads,
             -- The gallery list's own render facts (queries/gallery.ts RENDER_FACTS).
             ${RENDER_FACTS} AS render_facts,
             (a.features_compacted_at IS NOT NULL) AS compacted
      FROM email e
      LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
      -- The gallery's own rows (the caller's, never hidden, security or plain-text mail).
      WHERE e.id = ${emailId}::uuid AND ${sql.join(baseConditions(userId), sql` AND `)}`);
    return res.rows[0] ?? null;
  });
  if (!row) return null;

  const checks = row.checks
    ? Object.fromEntries(
        Object.entries(row.checks).map(([id, c]) => [
          id,
          { status: typeof c?.status === "string" ? c.status : "", value: c?.value ?? null },
        ]),
      )
    : null;
  // Whether the AI review's points count: from its checks while stored, else from the email's state.
  const aiChecks = checks ? AI_CHECKS.map((id) => checks[id]).filter((c) => c !== undefined) : [];
  const aiReviewed =
    aiChecks.length > 0
      ? aiChecks.some((c) => ["pass", "partial", "fail"].includes(c.status))
      : AI_DONE.has(row.design_ai_state);
  const pillars = pillarsOf(row.pillar_scores);
  return {
    score: row.design_score,
    band: row.design_band,
    capped: row.design_capped,
    provisional: row.design_provisional,
    caps: row.caps ?? [],
    issues: row.design_issues,
    source: row.design_source,
    coverageConfidence: row.coverage_confidence,
    signals: row.signals,
    primaryType: row.primary_type,
    raw: finite(row.summary_raw)
      ? row.summary_raw
      : finite(row.raw_score)
        ? Math.round(row.raw_score * 10) / 10
        : null,
    needs: needsOf(row.needs),
    pillars: pillars.length ? pillars : pillarsOf(row.summary_pillars),
    aiReviewed,
    checks,
    imageLoads: Array.isArray(row.loads) ? (row.loads as EvidenceInput["imageLoads"]) : null,
    // The card's own test (lib/gallery.ts noButtonBackedUp), so both word "no main button" alike.
    noButtonBacked: noButtonBackedUp(row.render_facts),
    compacted: row.compacted === true,
  };
}
