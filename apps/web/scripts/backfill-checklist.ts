/**
 * ONE-TIME — save the design checklist (@edf/design scoring/checklist.ts, 2026-11-05) for every
 * email analysed before it existed whose measured checks are still stored, so the gallery's
 * Good / Okay / Bad (lib/gallery.ts VERDICT POLICY) covers them at once instead of saying "Not
 * checked yet" until a new render.
 *
 *   DATABASE_URL_OWNER=… pnpm --filter @edf/web exec tsx scripts/backfill-checklist.ts [--write]
 *
 * Without --write it only reads and prints how many emails would get a checklist and the verdicts
 * they would get (counts only: no addresses, subjects or content). With --write it saves each one
 * into email_analysis.score_summary.checklist, exactly what summarizeScore saves for a new render:
 * designChecklist(checks, the summary's saved signals, or summarySignals(checks) when it has none).
 * Nothing else changes; no row is deleted. Emails whose checks were compacted away (an empty
 * array) can't be checked from what's stored: the nightly re-check renders them again
 * (@edf/pipeline render-policy.ts RECHECK_CANDIDATE_SQL). Static-only analyses never get one.
 *
 * Safe to run again: an email that already has a checklist of the current version is skipped.
 * Uses the database owner's connection (it reads and writes every user's rows), never printed.
 */
import { createPool } from "@edf/db";
import {
  CHECKLIST_VERSION,
  checklistVerdict,
  designChecklist,
  summarySignals,
  type CheckResult,
  type SummarySignals,
} from "@edf/design";

const write = process.argv.includes("--write");
const url = process.env.DATABASE_URL_OWNER ?? "";
if (!url) {
  console.error("Set DATABASE_URL_OWNER (the database owner's connection string).");
  process.exit(1);
}

interface Row {
  email_id: string;
  checks: CheckResult[];
  signals: unknown;
  coverage: string | null;
  design_source: string;
}

const BATCH = 200;

async function main(): Promise<void> {
  const pool = createPool({ connectionString: url, max: 2 });
  const tally = { candidates: 0, saved: 0, good: 0, ok: 0, bad: 0, skippedStatic: 0 };
  try {
    let after = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { rows } = await pool.query<Row>(
        `SELECT a.email_id, a.checks, a.score_summary -> 'signals' AS signals,
                a.score_summary ->> 'coverage' AS coverage, e.design_source
         FROM email_analysis a JOIN email e ON e.id = a.email_id AND e.user_id = a.user_id
         WHERE a.email_id > $1::uuid
           AND jsonb_typeof(a.checks) = 'array' AND jsonb_array_length(a.checks) > 0
           AND a.score_summary IS NOT NULL
           AND (a.score_summary #>> '{checklist,v}') IS DISTINCT FROM $2::text
         ORDER BY a.email_id LIMIT ${BATCH}`,
        [after, CHECKLIST_VERSION],
      );
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.email_id;
      for (const r of rows) {
        // summarizeScore saves none for static-only coverage; older summaries lack `coverage`,
        // so the email's design source says it then.
        const coverage = r.coverage ?? r.design_source;
        if (coverage !== "render" && coverage !== "template") {
          tally.skippedStatic++;
          continue;
        }
        tally.candidates++;
        const signals =
          typeof r.signals === "object" && r.signals !== null && !Array.isArray(r.signals)
            ? (r.signals as Partial<SummarySignals>)
            : summarySignals(r.checks);
        const checklist = designChecklist(r.checks, signals);
        tally[checklistVerdict(checklist)]++;
        if (!write) continue;
        const res = await pool.query(
          `UPDATE email_analysis SET score_summary = jsonb_set(score_summary, '{checklist}', $2::jsonb)
           WHERE email_id = $1 AND (score_summary #>> '{checklist,v}') IS DISTINCT FROM $3::text`,
          [r.email_id, JSON.stringify(checklist), CHECKLIST_VERSION],
        );
        tally.saved += res.rowCount ?? 0;
      }
    }
  } finally {
    await pool.end();
  }
  console.log(
    `${write ? "Saved" : "Would save"} a checklist for ${write ? tally.saved : tally.candidates} emails ` +
      `(Good ${tally.good}, Okay ${tally.ok}, Bad ${tally.bad}); ${tally.skippedStatic} static-only skipped.`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
