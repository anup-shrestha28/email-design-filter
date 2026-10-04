/**
 * Design gallery: every designed email as a card, newest first by default, filterable by category,
 * verdict (really good / really bad), font, a search and the Filters panel (score range, date,
 * senders, problems, mailbox, web fonts), with facet counts for the filters.
 *
 * Never listed: security-sensitive emails (never rendered anywhere), plain-text emails (no design)
 * and hidden mail (trash, spam, muted senders) — the inbox's "All mail" rules otherwise. Same
 * patterns as the inbox: dynamic WHERE clauses and an explicit `user_id` predicate, all inside
 * withUser (RLS is the backstop). The search is a condition like any other filter (never a capped
 * list of matches, lib/gallery-search.ts), so totals, pages and counts always cover every match.
 * Numbered pages use OFFSET / LIMIT over a fully deterministic ORDER BY (ties broken by id), so pages
 * never overlap or skip; the page's rows are picked first and only they are built into cards.
 */
import "server-only";
import { sql, type SQL } from "@edf/db";
import { raw } from "@edf/db";
import { withUser } from "@edf/db";
import type { DesignBand, DesignIssue, ScoreSummary } from "@edf/design/types";
import { previewFrameOf } from "@/lib/gallery-preview";
import { FOLD_FROM, FOLD_TO, parseGallerySearch, type SearchTerm } from "@/lib/gallery-search";
import { requestTimeZone } from "@/lib/request-context";
import {
  CONFIDENCE_EPSILON,
  COVERAGE_CONFIDENCE_MIN,
  EMAIL_GALLERY_CATEGORY_IDS,
  GALLERY_SHOWN_CATEGORIES,
  GOOD_SCORE_MIN,
  GOOD_SOURCES,
  CURRENT_SIGNALS_KEY,
  BIG_LINK_H,
  BIG_LINK_W,
  IMAGE_TEXT_CHARS_MAX,
  IMAGE_TEXT_SHARE_MIN,
  IMAGES_UNKNOWN_SHARE_MAX,
  LEGACY_SHRINK_K_MAX,
  LEGACY_TINY_PHONE_TEXT_PX,
  POOR_SCORE_MAX,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  UNSUBSCRIBE_REQUIRED_TYPE,
  categoryRules,
  galleryCategoryOf,
  galleryReason,
  verdictOf,
  type EmailGalleryCategory,
  type GalleryCategory,
  type GalleryParams,
  type GalleryProblem,
  type RenderFacts,
  GALLERY_DATE_DAYS,
  GALLERY_PROBLEMS,
  clampPage,
  nextDay,
  pageCountOf,
  zonedDayStart,
} from "@/lib/gallery";
import { getPool } from "../db";
import { imagesClickToLoad, type GovernorImageValue } from "../image-switch";
import { withWaiting } from "./gallery-waiting";
import type { GalleryFacets, GalleryItem, GalleryPage } from "./types";

/** Most ids one preview-URL request may ask for. */
export const MAX_PREVIEW_IDS = 48;
/** Fonts offered in the Font menu (most designs first): every font there is, in practice. */
const FONT_FACETS = 100;
/** Senders offered in the Filters panel (most designs first; the panel searches within them). */
const SENDER_FACETS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────── conditions ─────────────────────────

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/** Text-only: pictures cover less than this share of the email (0..1). */
export const TEXT_ONLY_IMG_SHARE_MAX = 0.1;
/** Text-only: no headline at least this many times the body text size. */
export const TEXT_ONLY_HEADLINE_RATIO_MIN = 1.5;

/**
 * A text-only email: HTML, but laid out like a plain letter — pictures under 10% of it, no button,
 * no coloured hero band, and no real headline (none, or under 1.5× the body text). Measured by the
 * render (score_summary.signals); an email not rendered yet — or scored before those facts were
 * recorded — is never text-only, so it shows until a render says otherwise. Self-contained (it reads email_analysis by `e.id` itself), so every
 * query that uses baseConditions keeps working whatever it joins. Owner's mail on 2026-10-03:
 * 87 of 614 (letters from Iman Gadzhi or Alex Hormozi, job-alert notes, terms-of-service notices,
 * application receipts, npm's 2FA notice).
 */
const TEXT_ONLY = sql`EXISTS (
  SELECT 1 FROM email_analysis ta
  CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(ta.score_summary -> 'signals') = 'object'
    THEN ta.score_summary -> 'signals' ELSE public.summary_signals(ta.checks) END AS s) ts
  WHERE ta.email_id = e.id AND ta.user_id = e.user_id
    AND jsonb_typeof(ts.s -> 'imgShare') = 'number'
    AND (ts.s ->> 'imgShare')::float8 < ${TEXT_ONLY_IMG_SHARE_MAX}::float8
    -- Measured (scoring 2026.5+ saves these keys, as JSON null when there is none): an older
    -- summary that never looked for a button or a headline is never taken for a letter.
    AND (ts.s -> 'ctaSalience') IS NOT NULL
    AND (ts.s -> 'hasHeadline') IS NOT NULL
    AND jsonb_typeof(ts.s -> 'ctaSalience') IS DISTINCT FROM 'number'
    AND (ts.s -> 'heroBand') IS DISTINCT FROM 'true'::jsonb
    AND ((ts.s -> 'hasHeadline') IS DISTINCT FROM 'true'::jsonb
      OR coalesce(CASE WHEN jsonb_typeof(ts.s -> 'headlineRatio') = 'number'
        THEN (ts.s ->> 'headlineRatio')::float8 END, 0) < ${TEXT_ONLY_HEADLINE_RATIO_MIN}::float8))`;

/**
 * What every gallery row must be (the inbox's "All mail" plus: designed — never plain-text or
 * text-only mail — and never security mail). Also the detail view's evidence query
 * (queries/gallery-evidence.ts), preview access and the boards' counts, so they never disagree.
 */
export function baseConditions(userId: string): SQL[] {
  return [
    sql`e.user_id = ${userId}`,
    sql`NOT e.is_hidden`,
    sql`NOT e.security_sensitive`,
    sql`e.design_status NOT IN ('plain_text', 'skipped')`,
    sql`NOT ${TEXT_ONLY}`,
    SHOWN_CATEGORIES,
  ];
}

/** Category membership, generated from galleryCategoryOf's rules so SQL and JS always agree. */
export function categoryCondition(category: EmailGalleryCategory): SQL {
  const parts = categoryRules(category).map((r) => {
    if (r.byDefault) {
      return r.except.length
        ? sql`(e.primary_type = ${r.primaryType} AND (e.subtype IS NULL OR NOT (e.subtype = ANY(${textArray(r.except)}))))`
        : sql`(e.primary_type = ${r.primaryType})`;
    }
    return sql`(e.primary_type = ${r.primaryType} AND e.subtype = ANY(${textArray(r.only)}))`;
  });
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`false`;
}

/**
 * The marketing categories the gallery shows (lib/gallery.ts GALLERY_SHOWN_CATEGORIES): an email
 * in any other category (newsletters, social, notifications, receipts, other) is never listed,
 * counted, previewed or opened from the gallery.
 */
const SHOWN_CATEGORIES = sql`(${sql.join(
  GALLERY_SHOWN_CATEGORIES.map((c) => categoryCondition(c)),
  sql` OR `,
)})`;

/**
 * The verdicts in SQL — exactly verdictOf()'s VERDICT POLICY (lib/gallery.ts); bad wins over good.
 * Needs JOIN_ANALYSIS (every cap that fired, the design-coverage confidence and the severe-problem
 * signals).
 *  - severe = capped, or any cap / issue chip fired, or the signals show one of the severe
 *             problems (severeTriggers: pictures that didn't load, text baked into images unless
 *             most of the picture area wasn't drawn, text that shrinks too small on phones, the
 *             unsubscribe link after Gmail's cut, mail that is promotional now (e.primary_type)
 *             without an unsubscribe link — v1.5 rules for rows scored before 2026.5), whatever
 *             'provisional' says
 *  - bad    = scored and (severe, or score < 60 / Poor band)
 *  - good   = score ≥ 85, not severe, render/template coverage, and not provisional for lack of
 *             design coverage (provisional only from an unsure email type doesn't block it)
 */
/**
 * The severe-problem signals (VerdictInput.signals): score_summary.signals, kept after compaction,
 * or — for rows scored before the engine saved them — the same facts from the stored checks
 * (migration 0015 summary_signals; compaction saves them into the summary before emptying checks).
 */
export const GALLERY_SIGNALS = sql`(CASE WHEN jsonb_typeof(a.score_summary -> 'signals') = 'object'
  THEN a.score_summary -> 'signals' ELSE public.summary_signals(a.checks) END)`;
/** GALLERY_SIGNALS as JOIN_ANALYSIS works it out: once per row (`sg`), however many tests read it. */
const SIGNALS = sql`sg.signals`;
type NumSignal =
  | "imgShare"
  | "legibleChars"
  | "phoneTextPx"
  | "layoutK"
  | "htmlContentImages"
  | "drawnContentImages"
  | "liveTextChars"
  | "imagesUnknownShare";
const signalNum = (key: NumSignal) =>
  sql`(CASE WHEN jsonb_typeof(${SIGNALS} -> ${sql.raw(`'${key}'`)}) = 'number'
    THEN (${SIGNALS} ->> ${sql.raw(`'${key}'`)})::float8 END)`;
const signalText = (key: "unsubscribe" | "unsubscribeUnion") =>
  sql`(${SIGNALS} ->> ${sql.raw(`'${key}'`)})`;
/**
 * currentSignals(): saved by scoring 2026.5 or later — the key is there, even as JSON null (`->`
 * then gives 'null'::jsonb, not SQL NULL). Older summaries and summary_signals() lack it.
 */
const CURRENT_SIGNALS = sql`((${SIGNALS} -> ${sql.raw(`'${CURRENT_SIGNALS_KEY}'`)}) IS NOT NULL)`;
/**
 * severeTriggers() in SQL, one test per trigger; each is NULL-safe (a missing signal never triggers
 * or blocks Good).
 */
const PICTURES_NOT_LOADED = sql`coalesce(${CURRENT_SIGNALS} AND ${signalNum("htmlContentImages")} >= 1::float8
  AND ${signalNum("drawnContentImages")} = 0::float8 AND ${signalNum("liveTextChars")} < ${IMAGE_TEXT_CHARS_MAX}::float8, false)`;
/** picturesUnknown(): most of the picture area wasn't drawn, so the share isn't trusted. */
const PICTURES_UNKNOWN = sql`coalesce(${CURRENT_SIGNALS} AND ${signalNum("imagesUnknownShare")} > ${IMAGES_UNKNOWN_SHARE_MAX}::float8, false)`;
const TEXT_IN_IMAGES = sql`coalesce(${signalNum("imgShare")} >= ${IMAGE_TEXT_SHARE_MIN}::float8 AND ${signalNum("legibleChars")} < ${IMAGE_TEXT_CHARS_MAX}::float8 AND NOT ${PICTURES_UNKNOWN}, false)`;
const TINY_PHONE_TEXT = sql`coalesce(CASE WHEN ${CURRENT_SIGNALS}
  THEN ${signalNum("layoutK")} < ${SHRINK_K_MAX}::float8 AND ${signalNum("phoneTextPx")} < ${TINY_PHONE_TEXT_PX}::float8
  ELSE ${signalNum("phoneTextPx")} < ${LEGACY_TINY_PHONE_TEXT_PX}::float8 AND ${signalNum("layoutK")} < ${LEGACY_SHRINK_K_MAX}::float8 END, false)`;
const UNSUBSCRIBE_CLIPPED = sql`coalesce(${CURRENT_SIGNALS} AND ${signalText("unsubscribeUnion")} = 'after_clip', false)`;
/** The current rule reads the email's type now (e.primary_type), as its category chip does. */
const NO_UNSUBSCRIBE = sql`coalesce(CASE WHEN ${CURRENT_SIGNALS}
  THEN e.primary_type = ${UNSUBSCRIBE_REQUIRED_TYPE}::text AND ${signalText("unsubscribeUnion")} = 'none'
  ELSE ${signalText("unsubscribe")} = 'none' END, false)`;
const SEVERE_SIGNALS = sql`(${PICTURES_NOT_LOADED} OR ${TEXT_IN_IMAGES} OR ${TINY_PHONE_TEXT} OR ${UNSUBSCRIBE_CLIPPED} OR ${NO_UNSUBSCRIBE})`;
const SEVERE = sql`(e.design_capped IS TRUE OR cardinality(e.design_issues) > 0 OR coalesce(cardinality(a.caps), 0) > 0 OR ${SEVERE_SIGNALS})`;
const LOW_SCORE = sql`(e.design_score < ${POOR_SCORE_MAX} OR e.design_band = 'poor')`;
const BAD = sql`(e.design_score IS NOT NULL AND (${SEVERE} OR ${LOW_SCORE}))`;
const GOOD = sql`(e.design_score >= ${GOOD_SCORE_MIN} AND e.design_band IS DISTINCT FROM 'poor' AND NOT ${SEVERE}
  AND e.design_source = ANY(${textArray(GOOD_SOURCES)})
  AND (e.design_provisional IS NOT TRUE OR coalesce(a.confidence::float8, 0) + ${CONFIDENCE_EPSILON}::float8 >= ${COVERAGE_CONFIDENCE_MIN}::float8))`;
/**
 * The verdict as a sort key: Bad 0 < Okay 1 < Good 2; unscored rows get -1 (best) / 3 (worst), so
 * they come last in both directions. Best / Worst sort by verdict first, then score, so the order
 * always matches the words on the cards (a capped "Bad · 69" never sorts above an "Okay · 65").
 */
const VERDICT_RANK = sql`(CASE WHEN e.design_score IS NULL THEN NULL WHEN ${BAD} THEN 0 WHEN ${GOOD} THEN 2 ELSE 1 END)`;
const BEST_RANK = sql`coalesce(${VERDICT_RANK}, -1)`;
const WORST_RANK = sql`coalesce(${VERDICT_RANK}, 3)`;
/**
 * The analysis row the verdict conditions read, and its signals (`sg.signals`) worked out once per
 * row: OFFSET 0 keeps Postgres from copying the expression into each of the ~20 tests that read
 * it, which read the whole score summary again every time (the counts took ~90 ms, now ~13 ms).
 */
const JOIN_ANALYSIS = sql`LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
  LEFT JOIN LATERAL (SELECT ${GALLERY_SIGNALS} AS signals OFFSET 0) sg ON true`;

function fontCondition(font: string): SQL {
  return sql`EXISTS (SELECT 1 FROM unnest(e.font_families) ff WHERE lower(ff) = ${font.toLowerCase()})`;
}

/** The subject and the sender's name as sent: where accent-free and punctuation-only searches look. */
const NAME_TEXT = sql`(coalesce(e.subject, '') || ' ' || coalesce(e.from_name, ''))`;
/** Any character outside ASCII: only such subjects / names can differ once accents are folded. */
const NON_ASCII = "[^\\x01-\\x7f]";
const RUN_START = "(^|[^[:alnum:]])";
const RUN_GAP = "[^[:alnum:]]+";
const RUN_END = "($|[^[:alnum:]])";

/**
 * A term's letters-and-digits runs as a regular expression: each run starts a word, runs are
 * separated by anything else, and a phrase also ends one. Runs are only letters, marks and digits
 * (lib/gallery-search.ts), so nothing in them is special to the regex.
 */
function runsPattern(runs: readonly string[], exact: boolean): string | null {
  if (runs.length === 0) return null;
  return RUN_START + runs.join(RUN_GAP) + (exact ? RUN_END : "");
}

/** One search term as SQL (lib/gallery-search.ts). Every value is a bound parameter. */
function termCondition(t: SearchTerm): SQL {
  let match: SQL;
  if (t.kind === "literal") {
    match = sql`(strpos(${NAME_TEXT}, ${t.parts[0]}::text) > 0)`;
  } else {
    // The index: a word is its pieces in a row, the last one a prefix ("don't" = don <-> t:*) unless
    // the word was typed with symbols after it ("C++" = c, exactly); a phrase is its words in a
    // row, exactly. quote_literal hands each piece to to_tsquery as text
    // (the pieces never hold a quote or a backslash), so no search can be read as query syntax.
    const tsq =
      t.kind === "phrase"
        ? sql`phraseto_tsquery('simple', ${t.parts[0]}::text)`
        : sql.join(
            t.parts.map((p, i) =>
              i === t.parts.length - 1 && !t.exact
                ? sql`to_tsquery('simple', quote_literal(${p}::text) || ':*')`
                : sql`to_tsquery('simple', quote_literal(${p}::text))`,
            ),
            sql` <-> `,
          );
    const re = runsPattern(t.runs, t.kind === "phrase" || t.exact === true);
    match = re
      ? sql`(e.search_tsv @@ (${tsq})
          OR coalesce(e.from_address::text, '') ~* ${re}::text
          OR (${NAME_TEXT} ~ ${NON_ASCII}::text
              AND lower(translate(${NAME_TEXT}, ${FOLD_FROM}::text, ${FOLD_TO}::text)) ~ ${re}::text))`
      : sql`(e.search_tsv @@ (${tsq}))`;
  }
  return t.not ? sql`NOT ${match}` : match;
}

/**
 * The search (lib/gallery-search.ts) as one condition: any alternative (`or`) whose terms all
 * match. A plain condition like the other filters, so every match counts (no capped list).
 */
function searchCondition(q: string): SQL | null {
  if (!q) return null;
  const alternatives = parseGallerySearch(q);
  if (alternatives.length === 0) return null;
  return sql`(${sql.join(
    alternatives.map((terms) => sql`(${sql.join(terms.map(termCondition), sql` AND `)})`),
    sql` OR `,
  )})`;
}

/** Design score within [min, max] (unscored designs never match a narrowed range). */
function scoreCondition(min: number, max: number): SQL | null {
  if (min <= 0 && max >= 100) return null;
  return sql`(e.design_score BETWEEN ${min}::int AND ${max}::int)`;
}

/**
 * The zone saved in Settings, read in SQL: only for callers that don't pass the request's zone
 * (`timeZone` below). It can't see the device, so "Automatic" reads as UTC there.
 */
const savedZone = (userId: string) =>
  sql`coalesce((SELECT us.timezone FROM user_settings us WHERE us.user_id = ${userId}), 'UTC')`;

/**
 * Received in the last N days, or between two calendar days (inclusive) in `timeZone`: the zone
 * the cards' dates are shown in (lib/request-context.ts requestTimeZone), so a picked day holds
 * exactly the cards dated that day. The day's first and last instants are worked out here and
 * bound as timestamps.
 */
function dateCondition(p: GalleryParams, userId: string, timeZone?: string): SQL | null {
  if (p.date === "any") return null;
  if (p.date !== "custom")
    return sql`e.received_at >= now() - make_interval(days => ${GALLERY_DATE_DAYS[p.date]}::int)`;
  const from = (day: string): SQL =>
    timeZone === undefined
      ? sql`(${day}::date::timestamp AT TIME ZONE ${savedZone(userId)})`
      : sql`${zonedDayStart(day, timeZone).toISOString()}::timestamptz`;
  const parts: SQL[] = [];
  if (p.since) parts.push(sql`e.received_at >= ${from(p.since)}`);
  if (p.until) parts.push(sql`e.received_at < ${from(nextDay(p.until))}`);
  return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : null;
}

/**
 * Has problem `x` (a Problems option, lib/gallery.ts GALLERY_PROBLEMS): a scored design whose cap
 * or issue chip for it fired, or that shows the severe problem the Bad cards name for it, or (Low
 * score) scores under 60 — galleryProblemsOf() in SQL. The filter and its counts both use this,
 * so a count is always what ticking the option shows, and the options together are exactly BAD.
 */
function problemCondition(x: GalleryProblem): SQL {
  const chip = sql`(${x} = ANY(e.design_issues))`;
  const cap = (id: string) => sql`coalesce(${id}::text = ANY(a.caps), false)`;
  let hit: SQL;
  switch (x) {
    case "image_only":
      hit = sql`(${chip} OR ${cap("CAP_IMAGE_ONLY")} OR ${TEXT_IN_IMAGES} OR ${PICTURES_NOT_LOADED})`;
      break;
    case "contrast":
      hit = sql`(${chip} OR ${cap("CAP_CONTRAST")})`;
      break;
    case "merge_tag":
      hit = sql`(${chip} OR ${cap("CAP_MERGE_TAG")})`;
      break;
    case "mobile":
      hit = sql`(${chip} OR ${cap("CAP_MOBILE_BROKEN")} OR ${TINY_PHONE_TEXT})`;
      break;
    case "clipped":
      hit = sql`(${chip} OR ${cap("CAP_CLIPPED")} OR ${UNSUBSCRIBE_CLIPPED})`;
      break;
    case "broken_images":
      hit = sql`(${chip} OR ${cap("CAP_BROKEN_IMAGES")})`;
      break;
    case "no_unsubscribe":
      hit = NO_UNSUBSCRIBE;
      break;
    case "low_score":
      hit = LOW_SCORE;
      break;
  }
  return sql`(e.design_score IS NOT NULL AND ${hit})`;
}

function uuidArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::uuid[]`;
}

type FilterKey =
  | "category"
  | "design"
  | "font"
  | "score"
  | "date"
  | "sender"
  | "problem"
  | "mailbox"
  | "webfonts"
  | "board"
  | "saved";
const FILTER_KEYS: readonly FilterKey[] = [
  "category",
  "design",
  "font",
  "score",
  "date",
  "sender",
  "problem",
  "mailbox",
  "webfonts",
  "board",
  "saved",
];

/** Every filter as SQL (null = off). Values are always bound parameters, never spliced text. */
function filterConditions(
  p: GalleryParams,
  userId: string,
  timeZone?: string,
): Record<FilterKey, SQL | null> {
  const senders = p.sender.filter((id) => UUID_RE.test(id));
  const problems = GALLERY_PROBLEMS.filter((x) => p.problem.includes(x));
  return {
    category: p.category === "all" ? null : categoryCondition(p.category),
    design: p.design === "good" ? GOOD : p.design === "bad" ? BAD : null,
    font: p.font ? fontCondition(p.font) : null,
    score: scoreCondition(p.smin, p.smax),
    date: dateCondition(p, userId, timeZone),
    sender: senders.length ? sql`e.sender_id = ANY(${uuidArray(senders)})` : null,
    // Any of the chosen problems (a design with two of them matches either).
    problem: problems.length ? sql`(${sql.join(problems.map(problemCondition), sql` OR `)})` : null,
    mailbox: p.mailbox && UUID_RE.test(p.mailbox) ? sql`e.mailbox_id = ${p.mailbox}::uuid` : null,
    webfonts:
      p.webfonts === "yes"
        ? sql`e.uses_web_fonts`
        : p.webfonts === "no"
          ? sql`NOT e.uses_web_fonts`
          : null,
    // Saved in that board (RLS: only the user's own boards and saves are visible).
    board:
      p.board && UUID_RE.test(p.board)
        ? sql`EXISTS (SELECT 1 FROM board_item bi WHERE bi.email_id = e.id AND bi.board_id = ${p.board}::uuid)`
        : null,
    // Saved in any of the user's boards (the "Saved" chip).
    saved: p.saved === "1" ? SAVED : null,
  };
}

/** Saved in at least one of the user's boards (RLS: only their own). */
const SAVED = sql`EXISTS (SELECT 1 FROM board_item bi WHERE bi.email_id = e.id)`;

/** The active filters' conditions, except `skip` (a facet group ignores its own selection). */
function activeConditions(filters: Record<FilterKey, SQL | null>, skip?: FilterKey): SQL[] {
  return FILTER_KEYS.filter((k) => k !== skip).flatMap((k) => (filters[k] ? [filters[k]] : []));
}

interface Row {
  id: string;
  received_at: Date;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  sender_name: string | null;
  sender_domain: string | null;
  primary_type: string;
  subtype: string | null;
  design_score: number | null;
  design_band: DesignBand | null;
  design_capped: boolean | null;
  design_provisional: boolean | null;
  design_issues: DesignIssue[];
  design_source: string;
  font_families: string[];
  needs: ScoreSummary["needsImprovement"] | null;
  good: ScoreSummary["good"] | null;
  summary_version: string | null;
  /** email_analysis.renderer_version: the render the stored features came from. */
  renderer_version: string | null;
  layout: unknown;
  caps: string[] | null;
  coverage_confidence: number | null;
  checks: unknown;
  /** GALLERY_SIGNALS: the severe-problem facts (VerdictInput.signals). */
  signals: unknown;
  /** RENDER_FACTS (null once compacted). */
  render_facts: RenderFacts | null;
  mailbox_status: string;
  /** Saved in at least one of the user's boards. */
  saved?: boolean | null;
}

/** Score keys that put unscored emails last in both directions (scores are 0..100). */
const BEST_KEY = sql`coalesce(e.design_score, -1)`;
const WORST_KEY = sql`coalesce(e.design_score, 101)`;

/**
 * The sort keys of each sort, in order. Every one ends in received_at, id — a total order, so
 * OFFSET pages never overlap or skip. Best / Worst rank by verdict first, then score (VERDICT_RANK).
 */
function sortKeys(sort: GalleryParams["sort"]): Array<{ key: SQL; desc: boolean }> {
  const tail = [
    { key: sql`e.received_at`, desc: true },
    { key: sql`e.id`, desc: true },
  ];
  switch (sort) {
    case "best":
      return [{ key: BEST_RANK, desc: true }, { key: BEST_KEY, desc: true }, ...tail];
    case "worst":
      return [{ key: WORST_RANK, desc: false }, { key: WORST_KEY, desc: false }, ...tail];
    case "newest":
    default:
      return tail;
  }
}

// ───────────────────────── row mapping ─────────────────────────

function toGalleryItem(r: Row): GalleryItem {
  const verdict = verdictOf({
    score: r.design_score,
    band: r.design_band,
    capped: r.design_capped,
    provisional: r.design_provisional,
    caps: r.caps ?? [],
    issues: r.design_issues,
    source: r.design_source,
    coverageConfidence: r.coverage_confidence,
    signals: r.signals,
    primaryType: r.primary_type,
  });
  const { reason, problems, strengths } = galleryReason(
    verdict,
    {
      needsImprovement: r.needs ?? [],
      good: r.good ?? [],
      ...(r.summary_version ? { scoringVersion: r.summary_version } : {}),
    },
    {
      capped: r.design_capped,
      caps: r.caps ?? [],
      issues: r.design_issues,
      checks: r.checks,
      subject: r.subject,
      fontsMeasured: r.font_families.length > 0,
      signals: r.signals,
      primaryType: r.primary_type,
      score: r.design_score,
      render: r.render_facts,
      // Only an own render re-reads this email's HTML pass (a template's render is another email's).
      rendererVersion: r.design_source === "render" ? r.renderer_version : null,
    },
  );
  const domain =
    r.sender_domain ??
    (r.from_address?.includes("@") ? r.from_address.split("@").pop()!.toLowerCase() : null);
  const name = [r.from_name, r.sender_name, r.from_address, domain].find(
    (x): x is string => typeof x === "string" && x.trim() !== "",
  );
  return {
    id: r.id,
    sender: { name: name?.trim() ?? "Unknown sender", domain },
    subject: r.subject,
    receivedAt: r.received_at.toISOString(),
    category: galleryCategoryOf(r.primary_type, r.subtype),
    score: r.design_score,
    band: r.design_band,
    verdict,
    reason,
    problems,
    strengths,
    fonts: r.font_families.slice(0, 3),
    previewable: r.mailbox_status === "active",
    frame: previewFrameOf(r.layout),
    saved: r.saved === true,
  };
}

// ───────────────────────── queries ─────────────────────────

/**
 * lib/gallery.ts RenderFacts from the stored features while they're kept (null once compaction
 * empties them): the buttons each pass found, standalone links a button's size on a phone, and
 * why the content images that weren't drawn weren't. Only numbers and reason words leave Postgres.
 * Also read by the detail view's evidence query (queries/gallery-evidence.ts).
 */
export const RENDER_FACTS = sql`(CASE WHEN jsonb_typeof(a.features) = 'object' THEN jsonb_build_object(
  'staticButtons', CASE WHEN jsonb_typeof(a.features #> '{static,cta,buttonLike}') = 'number' THEN a.features #> '{static,cta,buttonLike}' END,
  'buttons', CASE WHEN jsonb_typeof(a.features #> '{render,cta,buttonLike}') = 'number' THEN a.features #> '{render,cta,buttonLike}' END,
  'buttonLabels', CASE WHEN jsonb_typeof(a.features #> '{render,cta,labels}') = 'array' THEN jsonb_array_length(a.features #> '{render,cta,labels}') END,
  'buttonStyles', CASE WHEN jsonb_typeof(a.features #> '{render,cta,buttonStyles}') = 'number' THEN a.features #> '{render,cta,buttonStyles}' END,
  'bigLinks', CASE WHEN jsonb_typeof(a.features #> '{render,links,targets}') = 'array' THEN (
    SELECT count(*) FROM jsonb_array_elements(a.features #> '{render,links,targets}') t
    WHERE jsonb_typeof(t -> 0) = 'number' AND jsonb_typeof(t -> 1) = 'number'
      AND (t ->> 0)::float8 >= ${BIG_LINK_W}::float8 AND (t ->> 1)::float8 >= ${BIG_LINK_H}::float8) END,
  'missedImageReasons', CASE WHEN jsonb_typeof(a.features #> '{render,images,loads}') = 'array' THEN (
    SELECT coalesce(jsonb_agg(DISTINCT l ->> 'reason') FILTER (WHERE l ->> 'reason' IS NOT NULL), '[]'::jsonb)
    FROM jsonb_array_elements(a.features #> '{render,images,loads}') l
    WHERE (l -> 'decoded') IS DISTINCT FROM 'true'::jsonb) END
) END)`;

/**
 * Only the check fields galleryReason reads (id, status, w, pointsLost, value), and no value for
 * checks that weren't evaluated: roughly half the stored ~10 KB per email stays in Postgres.
 */
const CHECKS_PROJECTION = sql`(CASE WHEN jsonb_typeof(a.checks) = 'array' THEN (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', c -> 'id', 'status', c -> 'status', 'w', c -> 'w', 'pointsLost', c -> 'pointsLost',
    'value', CASE WHEN c ->> 'status' IN ('not_applicable', 'not_evaluated') THEN NULL ELSE c -> 'value' END
  )), '[]'::jsonb) FROM jsonb_array_elements(a.checks) c
) END)`;

/**
 * One numbered page of the gallery (`params.page`, `params.size` cards). A page past the end is
 * clamped to the last page; the result says which page it is and how many there are.
 *
 * The page's ids are picked first (the sort keys only), then just those rows are read in full —
 * the card fields (checks, signals, layout) are never built for the rows OFFSET skips, so page 27
 * costs about what page 1 does. `timeZone` is the zone the cards' dates are shown in (defaults to
 * this request's, lib/request-context.ts); "Pick dates" reads days in it.
 */
export async function listGallery(
  userId: string,
  params: GalleryParams,
  timeZone?: string,
): Promise<GalleryPage> {
  const pool = await getPool();
  const zone = timeZone ?? (await requestTimeZone(userId));
  const where = galleryViewConditions(userId, params, zone);
  const size = params.size;
  const keys = sortKeys(params.sort);
  const keyName = (i: number) => sql.raw(`k${i}`);
  const order = (prefix: string) =>
    sql.join(
      keys.map((k, i) => sql`${sql.raw(prefix)}${keyName(i)} ${sql.raw(k.desc ? "DESC" : "ASC")}`),
      sql`, `,
    );

  return withUser(pool, userId, async (db) => {
    const counted = await raw(db).execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM email e ${JOIN_ANALYSIS}
      WHERE ${sql.join(where, sql` AND `)}`);
    const total = Number(counted.rows[0]?.n ?? 0);
    const page = clampPage(params.page, total, size);
    const res =
      total === 0
        ? { rows: [] as Row[] }
        : await raw(db).execute<Row>(sql`
      WITH pick AS (
        SELECT e.id, ${sql.join(
          keys.map((k, i) => sql`${k.key} AS ${keyName(i)}`),
          sql`, `,
        )}
        FROM email e ${JOIN_ANALYSIS}
        WHERE ${sql.join(where, sql` AND `)}
        ORDER BY ${order("")}
        LIMIT ${size}::int OFFSET ${(page - 1) * size}::int
      )
      SELECT e.id, e.received_at, e.subject, e.from_name, e.from_address::text AS from_address,
             s.display_name AS sender_name, s.domain AS sender_domain, e.primary_type, e.subtype,
             e.design_score, e.design_band, e.design_capped, e.design_provisional, e.design_issues, e.design_source, e.font_families,
             a.score_summary -> 'needsImprovement' AS needs, a.score_summary -> 'good' AS good,
             a.score_summary ->> 'scoringVersion' AS summary_version, a.renderer_version,
             -- score_summary.layout is kept after compaction (migration 0016); features until then.
             coalesce(a.score_summary -> 'layout', a.features #> '{render,layout}') AS layout,
             a.caps, a.confidence::float8 AS coverage_confidence,
             ${CHECKS_PROJECTION} AS checks,
             ${SIGNALS} AS signals,
             ${RENDER_FACTS} AS render_facts,
             m.status AS mailbox_status,
             EXISTS (SELECT 1 FROM board_item bi WHERE bi.email_id = e.id) AS saved
      FROM pick
      JOIN email e ON e.id = pick.id AND e.user_id = ${userId}
      JOIN mailbox m ON m.id = e.mailbox_id AND m.user_id = e.user_id
      LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      ${JOIN_ANALYSIS}
      ORDER BY ${order("pick.")}`);
    return {
      // Unscored cards say when their score comes, from the real render queue (gallery-waiting.ts).
      items: await withWaiting(db, userId, res.rows.map(toGalleryItem)),
      total,
      page,
      pageSize: size,
      pageCount: pageCountOf(total, size),
    };
  });
}

/**
 * The designs a gallery view lists: every filter and the search of `params` (not the page), over
 * `email e` with the analysis joined as `a` (GALLERY_VIEW_JOIN). listGallery's WHERE, and the live
 * gallery's check for new designs in the same view (gallery-live.ts). Pass the request's
 * `timeZone` (lib/request-context.ts requestTimeZone) so "Pick dates" reads the days the cards
 * show; without it the zone saved in Settings is used, with "Automatic" read as UTC.
 */
export function galleryViewConditions(
  userId: string,
  params: GalleryParams,
  timeZone?: string,
): SQL[] {
  const where = [
    ...baseConditions(userId),
    ...activeConditions(filterConditions(params, userId, timeZone)),
  ];
  const search = searchCondition(params.q);
  if (search) where.push(search);
  return where;
}
/** The join galleryViewConditions needs (the verdict filters read the analysis). */
export const GALLERY_VIEW_JOIN = JOIN_ANALYSIS;

/**
 * Filter counts; each group ignores its own selection and respects the others (and the search).
 * Never cached: they're read with the page itself, so the counts and the list always describe the
 * same moment, however new mail or a finished score just changed things. `timeZone` as listGallery.
 */
export async function galleryFacets(
  userId: string,
  params: GalleryParams,
  timeZone?: string,
): Promise<GalleryFacets> {
  const pool = await getPool();
  const zone = timeZone ?? (await requestTimeZone(userId));
  const base = baseConditions(userId);
  const search = searchCondition(params.q);
  if (search) base.push(search);
  const filters = filterConditions(params, userId, zone);
  const othersThan = (k: FilterKey): SQL => {
    const conds = activeConditions(filters, k);
    return conds.length ? sql.join(conds, sql` AND `) : sql`true`;
  };
  const fCat = othersThan("category");
  const fDesign = othersThan("design");
  const fFont = othersThan("font");
  const fProblem = othersThan("problem");
  const fWeb = othersThan("webfonts");
  const fSender = othersThan("sender");
  const fMailbox = othersThan("mailbox");
  const fBoard = othersThan("board");
  // The "Saved" chip shows saved designs of every type: neither its own nor the type filter counts.
  const savedOthers = FILTER_KEYS.filter((k) => k !== "saved" && k !== "category").flatMap((k) =>
    filters[k] ? [filters[k]] : [],
  );
  const fSaved = savedOthers.length ? sql.join(savedOthers, sql` AND `) : sql`true`;
  const selected = params.sender.filter((id) => UUID_RE.test(id));
  const selectedFirst = selected.length ? sql`(s.id = ANY(${uuidArray(selected)})) DESC, ` : sql``;

  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<Record<string, string>>(sql`
      SELECT
        count(*) FILTER (WHERE ${fCat}) AS "c_all",
        ${sql.join(
          EMAIL_GALLERY_CATEGORY_IDS.map(
            (c) =>
              sql`count(*) FILTER (WHERE ${categoryCondition(c)} AND ${fCat}) AS ${sql.raw(`"c_${c}"`)}`,
          ),
          sql`, `,
        )},
        count(*) FILTER (WHERE ${fDesign}) AS "d_all",
        count(*) FILTER (WHERE ${GOOD} AND ${fDesign}) AS "d_good",
        count(*) FILTER (WHERE ${BAD} AND ${fDesign}) AS "d_bad",
        ${sql.join(
          GALLERY_PROBLEMS.map(
            (x) =>
              sql`count(*) FILTER (WHERE ${problemCondition(x)} AND ${fProblem}) AS ${sql.raw(`"p_${x}"`)}`,
          ),
          sql`, `,
        )},
        count(*) FILTER (WHERE e.uses_web_fonts AND ${fWeb}) AS "w_yes",
        count(*) FILTER (WHERE NOT e.uses_web_fonts AND ${fWeb}) AS "w_no",
        count(*) FILTER (WHERE ${SAVED} AND ${fSaved}) AS "saved"
      FROM email e
      ${JOIN_ANALYSIS}
      WHERE ${sql.join(base, sql` AND `)}`);
    // Fonts grouped case-insensitively, labelled with their most common spelling (ties: one with
    // capitals, then alphabetical), so "Inter" and "inter" are one option.
    const fonts = await raw(db).execute<{ label: string; n: string }>(sql`
      WITH ff AS (
        SELECT e.id, f FROM email e ${JOIN_ANALYSIS} CROSS JOIN LATERAL unnest(e.font_families) f
        WHERE ${sql.join([...base, fFont], sql` AND `)}
      ),
      spellings AS (SELECT lower(f) AS k, f, count(*) AS n FROM ff GROUP BY 1, 2),
      labels AS (SELECT DISTINCT ON (k) k, f AS label FROM spellings ORDER BY k, n DESC, (f = lower(f)), f)
      SELECT l.label, count(DISTINCT ff.id) AS n
      FROM ff JOIN labels l ON l.k = lower(ff.f)
      GROUP BY l.k, l.label
      ORDER BY n DESC, l.k
      LIMIT ${FONT_FACETS}`);
    // Top senders; the selected ones always make the list (first), so their chips keep a name.
    const SENDER_NAME = sql`coalesce(nullif(btrim(s.display_name), ''), s.domain, s.address::text)`;
    const senders = await raw(db).execute<{
      id: string;
      name: string;
      domain: string | null;
      address: string;
      n: string;
    }>(sql`
      SELECT s.id, ${SENDER_NAME} AS name, s.domain, s.address::text AS address, count(*) AS n
      FROM email e
      JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      ${JOIN_ANALYSIS}
      WHERE ${sql.join([...base, fSender], sql` AND `)}
      GROUP BY s.id
      ORDER BY ${selectedFirst}n DESC, name, s.id
      LIMIT ${SENDER_FACETS}::int`);
    const listed = new Set(senders.rows.map((r) => r.id));
    const missing = selected.filter((id) => !listed.has(id));
    const unmatched = missing.length
      ? (
          await raw(db).execute<{
            id: string;
            name: string;
            domain: string | null;
            address: string;
          }>(sql`
            SELECT s.id, ${SENDER_NAME} AS name, s.domain, s.address::text AS address FROM sender s
            WHERE s.user_id = ${userId} AND s.id = ANY(${uuidArray(missing)})`)
        ).rows
      : [];
    const mailboxes = await raw(db).execute<{ id: string; address: string; n: string }>(sql`
      SELECT m.id, m.email_address::text AS address,
             (SELECT count(*) FROM email e ${JOIN_ANALYSIS}
              WHERE e.mailbox_id = m.id AND ${sql.join([...base, fMailbox], sql` AND `)}) AS n
      FROM mailbox m
      WHERE m.user_id = ${userId} AND m.status <> 'disconnecting'
      ORDER BY m.created_at, m.id`);
    // Every board (an empty one still names its chip), with its saves that match the other filters.
    const boards = await raw(db).execute<{ id: string; name: string; n: string }>(sql`
      SELECT b.id, b.name,
             (SELECT count(*) FROM board_item bi JOIN email e ON e.id = bi.email_id AND e.user_id = bi.user_id
              ${JOIN_ANALYSIS}
              WHERE bi.board_id = b.id AND ${sql.join([...base, fBoard], sql` AND `)}) AS n
      FROM board b
      WHERE b.user_id = ${userId}
      ORDER BY b.created_at DESC, b.id`);
    const row = res.rows[0] ?? {};
    const n = (k: string) => Number(row[k] ?? 0);
    return {
      categories: Object.fromEntries([
        ["all", n("c_all")],
        ...EMAIL_GALLERY_CATEGORY_IDS.map((c) => [c, n(`c_${c}`)]),
      ]) as Record<GalleryCategory, number>,
      design: { all: n("d_all"), good: n("d_good"), bad: n("d_bad") },
      fonts: fonts.rows.map((r) => ({ name: r.label, count: Number(r.n) })),
      senders: [
        ...senders.rows.map((r) => ({
          id: r.id,
          name: r.name,
          domain: r.domain,
          address: r.address,
          count: Number(r.n),
        })),
        ...unmatched.map((r) => ({
          id: r.id,
          name: r.name,
          domain: r.domain,
          address: r.address,
          count: 0,
        })),
      ],
      problems: Object.fromEntries(GALLERY_PROBLEMS.map((x) => [x, n(`p_${x}`)])) as Record<
        GalleryProblem,
        number
      >,
      mailboxes: mailboxes.rows.map((r) => ({ id: r.id, address: r.address, count: Number(r.n) })),
      webFonts: { yes: n("w_yes"), no: n("w_no") },
      boards: boards.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.n) })),
      saved: n("saved"),
    };
  });
}

/**
 * Of `ids`, the ones this user may preview in the gallery: their own (explicit predicate + RLS),
 * listed in the gallery (so never security-sensitive or plain text) and in a connected mailbox.
 */
export async function previewableIds(userId: string, ids: readonly string[]): Promise<string[]> {
  return (await previewAccess(userId, "owner", ids)).ids;
}

/**
 * The caller's previewable ids among `ids` (≤ MAX_PREVIEW_IDS) and whether the governor has made
 * images click-to-load for the caller's role (FREE-TIER.md §8.2–8.3, server/image-switch.ts): then
 * cards are shown without images and the opened design asks before loading them.
 */
export async function previewAccess(
  userId: string,
  role: "owner" | "friend",
  ids: readonly string[],
): Promise<{ ids: string[]; imagesOff: boolean }> {
  const wanted = [
    ...new Set(
      ids.filter((id) => typeof id === "string" && UUID_RE.test(id)).map((id) => id.toLowerCase()),
    ),
  ].slice(0, MAX_PREVIEW_IDS);
  if (!wanted.length) return { ids: [], imagesOff: false };
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<{ id: string }>(sql`
      SELECT e.id FROM email e
      JOIN mailbox m ON m.id = e.mailbox_id AND m.user_id = e.user_id
      WHERE ${sql.join(baseConditions(userId), sql` AND `)}
        AND m.status = 'active'
        AND e.id = ANY(${sql`ARRAY[${sql.join(
          wanted.map((id) => sql`${id}`),
          sql`, `,
        )}]::uuid[]`})`);
    const gov = await raw(db).execute<{ value: GovernorImageValue }>(
      sql`SELECT value FROM app_setting WHERE key = 'governor'`,
    );
    return {
      ids: res.rows.map((r) => r.id),
      imagesOff: imagesClickToLoad(gov.rows[0]?.value ?? null, role),
    };
  });
}
