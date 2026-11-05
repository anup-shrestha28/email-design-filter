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
import { BAD_MISSES_MIN, CHECKLIST_VERSION } from "@edf/design/checklist";
import type { DesignBand } from "@edf/design/types";
import { previewFrameOf } from "@/lib/gallery-preview";
import { FOLD_FROM, FOLD_TO, parseGallerySearch, type SearchTerm } from "@/lib/gallery-search";
import { requestTimeZone } from "@/lib/request-context";
import {
  EMAIL_GALLERY_CATEGORY_IDS,
  GALLERY_SHOWN_CATEGORIES,
  categoryRules,
  checklistReason,
  galleryCategoryOf,
  verdictOf,
  type EmailGalleryCategory,
  type GalleryCategory,
  type GalleryParams,
  type GalleryProblem,
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

/** A saved checklist count (`misses` / `unknown`) as a number, when it is one. */
const checklistCount = (key: "misses" | "unknown") =>
  sql`(CASE WHEN jsonb_typeof(a.score_summary #> ${sql.raw(`'{checklist,${key}}'`)}) = 'number'
    THEN (a.score_summary #>> ${sql.raw(`'{checklist,${key}}'`)})::numeric END)`;
const isCount = (x: SQL) => sql`coalesce(${x} >= 0 AND ${x} = trunc(${x}), false)`;
/**
 * The saved checklist (score_summary.checklist) when it is of the current version with both counts
 * whole numbers ≥ 0, else NULL — lib/gallery.ts storedChecklist() in SQL.
 */
const CHECKLIST_OF = sql`(CASE WHEN a.score_summary #>> '{checklist,v}' = ${CHECKLIST_VERSION}::text
  AND ${isCount(checklistCount("misses"))} AND ${isCount(checklistCount("unknown"))}
  THEN a.score_summary -> 'checklist' END)`;
/** CHECKLIST_OF as JOIN_ANALYSIS works it out: once per row (`ck`), however many tests read it. */
const CHECKLIST = sql`ck.checklist`;
const MISSES = sql`((${CHECKLIST} ->> 'misses')::numeric)`;
const UNKNOWN = sql`((${CHECKLIST} ->> 'unknown')::numeric)`;
/**
 * The verdicts in SQL — exactly verdictOf()'s VERDICT POLICY (lib/gallery.ts), from the checklist
 * alone: Bad = three or more rules missed; Good = none missed and none unchecked; Okay = any other
 * checked design; no checklist = not checked yet (neither). Needs JOIN_ANALYSIS.
 */
const BAD = sql`coalesce(${MISSES} >= ${BAD_MISSES_MIN}::numeric, false)`;
const GOOD = sql`coalesce(${MISSES} = 0 AND ${UNKNOWN} = 0, false)`;
/**
 * The verdict as a sort key: Bad 0 < Okay 1 < Good 2; unchecked rows get -1 (best) / 3 (worst), so
 * they come last in both directions. Best / Worst sort by verdict first, then the rules missed,
 * then the score, so the order always matches the words on the cards.
 */
const VERDICT_RANK = sql`(CASE WHEN ${CHECKLIST} IS NULL THEN NULL WHEN ${BAD} THEN 0 WHEN ${GOOD} THEN 2 ELSE 1 END)`;
const BEST_RANK = sql`coalesce(${VERDICT_RANK}, -1)`;
const WORST_RANK = sql`coalesce(${VERDICT_RANK}, 3)`;
/**
 * The analysis row the verdict conditions read, and its checklist (`ck.checklist`) worked out once
 * per row (OFFSET 0 keeps Postgres from copying the expression into each test that reads it).
 */
const JOIN_ANALYSIS = sql`LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
  LEFT JOIN LATERAL (SELECT ${CHECKLIST_OF} AS checklist OFFSET 0) ck ON true`;

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
 * Missed rule `x` (a Problems option, lib/gallery.ts GALLERY_PROBLEMS): its saved checklist has
 * that rule with the result "miss" — galleryProblemsOf() in SQL. The filter and its counts both
 * use this, so a count is always what ticking the option shows.
 */
function problemCondition(x: GalleryProblem): SQL {
  return sql`coalesce(${CHECKLIST} -> 'rules' @> jsonb_build_array(jsonb_build_object('id', ${x}::text, 'result', 'miss')), false)`;
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
  font_families: string[];
  layout: unknown;
  /** CHECKLIST: the saved checklist of the current version (null when there is none). */
  checklist: unknown;
  mailbox_status: string;
  /** Saved in at least one of the user's boards. */
  saved?: boolean | null;
}

/** Score keys that put unscored emails last in both directions (scores are 0..100). */
const BEST_KEY = sql`coalesce(e.design_score, -1)`;
const WORST_KEY = sql`coalesce(e.design_score, 101)`;
/** Rules missed, unchecked designs last in both directions (there are 16 rules). */
const FEWEST_MISSES_KEY = sql`coalesce(${MISSES}, 99)`;
const MOST_MISSES_KEY = sql`coalesce(${MISSES}, -1)`;

/**
 * The sort keys of each sort, in order. Every one ends in received_at, id — a total order, so
 * OFFSET pages never overlap or skip. Best / Worst rank by verdict first, then the rules missed,
 * then the score (VERDICT_RANK).
 */
function sortKeys(sort: GalleryParams["sort"]): Array<{ key: SQL; desc: boolean }> {
  const tail = [
    { key: sql`e.received_at`, desc: true },
    { key: sql`e.id`, desc: true },
  ];
  switch (sort) {
    case "best":
      return [
        { key: BEST_RANK, desc: true },
        { key: FEWEST_MISSES_KEY, desc: false },
        { key: BEST_KEY, desc: true },
        ...tail,
      ];
    case "worst":
      return [
        { key: WORST_RANK, desc: false },
        { key: MOST_MISSES_KEY, desc: true },
        { key: WORST_KEY, desc: false },
        ...tail,
      ];
    case "newest":
    default:
      return tail;
  }
}

// ───────────────────────── row mapping ─────────────────────────

function toGalleryItem(r: Row): GalleryItem {
  const verdict = verdictOf({ checklist: r.checklist });
  const { reason, problems, strengths } = checklistReason(r.checklist);
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
             e.design_score, e.design_band, e.font_families,
             -- score_summary.layout is kept after compaction (migration 0016); features until then.
             coalesce(a.score_summary -> 'layout', a.features #> '{render,layout}') AS layout,
             ${CHECKLIST} AS checklist,
             m.status AS mailbox_status,
             EXISTS (SELECT 1 FROM board_item bi WHERE bi.email_id = e.id) AS saved
      FROM pick
      JOIN email e ON e.id = pick.id AND e.user_id = ${userId}
      JOIN mailbox m ON m.id = e.mailbox_id AND m.user_id = e.user_id
      LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      ${JOIN_ANALYSIS}
      ORDER BY ${order("pick.")}`);
    return {
      // Unchecked cards say when their check comes, from the real render queue (gallery-waiting.ts).
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
