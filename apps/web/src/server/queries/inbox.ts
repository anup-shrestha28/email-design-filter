/**
 * Inbox list, facet counts, font options and smart-view counts (DESIGN.md §9, DATA-MODEL.md §5).
 *
 * Lists use dynamic WHERE clauses (never the catch-all `($x IS NULL OR col = $x)`), keyset
 * pagination and an explicit `user_id` predicate so the timeline index is used; RLS is the
 * backstop. Search goes through the `search_emails()` definer function.
 */
import "server-only";
import { sql, type SQL } from "@edf/db";
import { raw } from "@edf/db";
import { withUser, type Db } from "@edf/db";
import { effectiveImportance } from "@edf/core";
import { TYPE_GROUPS, type EmailType, type Importance, type TypeGroup } from "@edf/core/types";
import type { DesignIssue } from "@edf/design/types";
import { splitSearch } from "@/lib/filters";
import { typeGroupOf } from "@/lib/types-display";
import { getPool } from "../db";
import type {
  DealFilter,
  DesignFilter,
  FacetCounts,
  FontOption,
  InboxFilters,
  InboxItem,
  InboxPage,
  SmartView,
  SmartViewCount,
} from "./types";
import { SMART_VIEWS } from "./types";

const PAGE_SIZE = 50;

// ───────────────────────── row mapping ─────────────────────────

export const INBOX_COLUMNS = sql`
  e.id, e.received_at, e.subject, e.snippet, e.from_name, e.from_address::text AS from_address, e.sender_id,
  s.domain AS sender_domain, e.primary_type, e.subtype, e.type_source, e.importance, e.importance_score,
  e.importance_reasons, e.design_status, e.design_source, e.design_ai_state, e.design_score, e.design_band,
  e.design_provisional, e.design_capped, e.design_issues, e.design_confidence, e.has_deal, e.deal_ends_at,
  e.deal_has_code, e.is_unread, e.opened_in_app_at, e.done_at, e.pinned_at, e.is_starred, e.suspicious,
  e.security_sensitive, e.is_subscription, e.font_families, e.tracker_count`;

export interface InboxRow {
  id: string;
  received_at: Date;
  subject: string | null;
  snippet: string | null;
  from_name: string | null;
  from_address: string | null;
  sender_id: string | null;
  sender_domain: string | null;
  primary_type: EmailType;
  subtype: string | null;
  type_source: InboxItem["typeSource"];
  importance: Importance;
  importance_score: number | null;
  importance_reasons: string[];
  design_status: InboxItem["design"]["status"];
  design_source: InboxItem["design"]["source"];
  design_ai_state: InboxItem["design"]["aiState"];
  design_score: number | null;
  design_band: InboxItem["design"]["band"];
  design_provisional: boolean | null;
  design_capped: boolean | null;
  design_issues: DesignIssue[];
  design_confidence: InboxItem["design"]["confidence"];
  has_deal: boolean;
  deal_ends_at: Date | null;
  deal_has_code: boolean;
  is_unread: boolean;
  opened_in_app_at: Date | null;
  done_at: Date | null;
  pinned_at: Date | null;
  is_starred: boolean;
  suspicious: boolean;
  security_sensitive: boolean;
  is_subscription: boolean;
  font_families: string[];
  tracker_count: number;
}

export function toInboxItem(r: InboxRow, now = new Date()): InboxItem {
  const eff =
    r.importance_score === null
      ? { level: r.importance, reasons: r.importance_reasons }
      : effectiveImportance({ score: r.importance_score, reasons: r.importance_reasons }, now);
  return {
    id: r.id,
    receivedAt: r.received_at.toISOString(),
    subject: r.subject,
    snippet: r.security_sensitive ? null : r.snippet,
    fromName: r.from_name,
    fromAddress: r.from_address,
    senderId: r.sender_id,
    senderDomain: r.sender_domain,
    primaryType: r.primary_type,
    typeGroup: typeGroupOf(r.primary_type),
    subtype: r.subtype,
    typeSource: r.type_source,
    importance: eff.level,
    importanceReasons: eff.reasons.filter((x) => !x.startsWith("boost:")),
    design: {
      status: r.design_status,
      source: r.design_source,
      aiState: r.design_ai_state,
      score: r.design_score,
      band: r.design_band,
      provisional: Boolean(r.design_provisional),
      capped: Boolean(r.design_capped),
      issues: r.design_issues,
      confidence: r.design_confidence,
    },
    deal: r.has_deal ? { endsAt: r.deal_ends_at?.toISOString() ?? null, hasCode: r.deal_has_code } : null,
    isUnread: r.is_unread,
    openedInApp: r.opened_in_app_at !== null,
    done: r.done_at !== null,
    pinned: r.pinned_at !== null,
    starred: r.is_starred,
    suspicious: r.suspicious,
    securitySensitive: r.security_sensitive,
    isSubscription: r.is_subscription,
    fontFamilies: r.font_families.slice(0, 3),
    trackerCount: r.tracker_count,
  };
}

// ───────────────────────── WHERE builders ─────────────────────────

const RECEIPT_TYPES: EmailType[] = ["transactional", "account_security", "account_notice"];

function typesOf(groups: readonly TypeGroup[]): EmailType[] {
  return groups.flatMap((g) => [...TYPE_GROUPS[g]]);
}

function textArray(values: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

function viewCondition(view: SmartView): SQL {
  switch (view) {
    case "needs_attention":
      return sql`e.importance = 'high' AND e.done_at IS NULL
        AND ((e.is_unread AND e.opened_in_app_at IS NULL) OR e.received_at > now() - interval '14 days')`;
    case "deals_ending":
      return sql`e.has_deal AND e.deal_ends_at > now() AND e.deal_ends_at <= now() + interval '48 hours'`;
    case "security":
      return sql`e.primary_type IN ('account_security', 'account_notice')`;
    case "suspicious":
      return sql`e.suspicious`;
    case "newsletters_i_read":
      return sql`e.primary_type = 'newsletter' AND s.read_rate_60d >= 0.5`;
    case "best_designed":
      return sql`e.design_score >= 85 AND e.design_provisional IS NOT TRUE`;
    case "bad_design":
      return sql`(e.design_band = 'poor' OR e.design_capped) AND e.design_provisional IS NOT TRUE`;
    case "new_senders":
      return sql`s.first_seen_at > now() - interval '14 days' AND s.seen_before_window IS NOT TRUE`;
    case "cleanup_never_opened":
      return sql`s.email_count >= 5 AND coalesce(s.read_rate_60d, 0) < 0.1`;
    case "still_sending":
      return sql`s.unsubscribed_at IS NOT NULL AND e.received_at > s.unsubscribed_at + interval '3 days'`;
  }
}

function designCondition(values: readonly DesignFilter[]): SQL | null {
  const parts = values.map((v) => {
    switch (v) {
      case "good":
        return sql`(e.design_band IN ('excellent', 'good') AND e.design_provisional IS NOT TRUE)`;
      case "needs_work":
        return sql`(e.design_band = 'needs_work' AND e.design_provisional IS NOT TRUE)`;
      case "bad":
        return sql`(e.design_band = 'poor' AND e.design_provisional IS NOT TRUE)`;
      case "provisional":
        return sql`(e.design_provisional IS TRUE)`;
      case "plain_text":
        return sql`(e.design_status = 'plain_text')`;
      case "not_analysed":
        return sql`(e.design_score IS NULL AND e.design_status NOT IN ('plain_text', 'skipped'))`;
    }
  });
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : null;
}

function dealCondition(values: readonly DealFilter[]): SQL | null {
  const parts = values.map((v) => {
    switch (v) {
      case "active":
        return sql`(e.has_deal AND (e.deal_ends_at IS NULL OR e.deal_ends_at > now()))`;
      case "ending":
        return sql`(e.has_deal AND e.deal_ends_at > now() AND e.deal_ends_at <= now() + interval '48 hours')`;
      case "has_code":
        return sql`(e.deal_has_code)`;
    }
  });
  return parts.length ? sql`(${sql.join(parts, sql` OR `)})` : null;
}

type FacetKey = "types" | "importance" | "design" | "issues" | "deals";
const FACET_KEYS: readonly FacetKey[] = ["types", "importance", "design", "issues", "deals"];

/** Facet-level conditions (OR within a facet); null when the facet has no selection. */
function facetConditions(f: InboxFilters): Record<FacetKey, SQL | null> {
  return {
    types: f.types.length ? sql`e.primary_type = ANY(${textArray(typesOf(f.types))})` : null,
    importance: f.importance.length ? sql`e.importance = ANY(${textArray(f.importance)})` : null,
    design: designCondition(f.design),
    issues: f.issues.length ? sql`e.design_issues && ${textArray(f.issues)}` : null,
    deals: dealCondition(f.deals),
  };
}

/** Every non-facet condition (AND across). */
function baseConditions(userId: string, f: InboxFilters): SQL[] {
  const c: SQL[] = [sql`e.user_id = ${userId}`, sql`NOT e.is_hidden`];
  if (f.scope === "subscriptions") c.push(sql`e.is_subscription`);
  if (f.scope === "receipts") c.push(sql`e.primary_type = ANY(${textArray(RECEIPT_TYPES)})`);
  if (f.view) c.push(viewCondition(f.view));
  if (f.subtypes.length) c.push(sql`e.subtype = ANY(${textArray(f.subtypes)})`);
  if (f.fonts.length) {
    c.push(sql`EXISTS (SELECT 1 FROM unnest(e.font_families) ff WHERE lower(ff) = ANY(${textArray(f.fonts)}))`);
  }
  if (f.webFonts) c.push(sql`e.uses_web_fonts`);
  if (f.senderId) c.push(sql`e.sender_id = ${f.senderId}`);
  if (f.newSenders) c.push(viewCondition("new_senders"));
  if (f.frequency.length) c.push(sql`s.frequency_band = ANY(${textArray(f.frequency)})`);
  if (f.stillSending) c.push(viewCondition("still_sending"));
  if (f.unread) c.push(sql`e.is_unread`);
  if (f.notOpened) c.push(sql`e.opened_in_app_at IS NULL`);
  if (f.done === "done") c.push(sql`e.done_at IS NOT NULL`);
  if (f.done === "not_done") c.push(sql`e.done_at IS NULL`);
  if (f.pinned) c.push(sql`e.pinned_at IS NOT NULL`);
  if (f.suspicious) c.push(sql`e.suspicious`);
  if (f.date) {
    const interval = { "24h": "1 day", "7d": "7 days", "30d": "30 days", "90d": "90 days" }[f.date];
    c.push(sql`e.received_at > now() - ${interval}::interval`);
  }
  if (f.mailboxId) c.push(sql`e.mailbox_id = ${f.mailboxId}`);
  if (f.language) c.push(sql`e.language = ${f.language}`);
  // "Deal ending soonest" lists only deals that haven't ended yet (the same rule as the Active deal
  // filter): ascending order would otherwise put the longest-expired promotions at the top.
  if (f.sort === "deal_ending") c.push(sql`e.has_deal AND (e.deal_ends_at IS NULL OR e.deal_ends_at > now())`);
  return c;
}

/** All conditions for the list: base AND every selected facet. */
function buildConditions(userId: string, f: InboxFilters): SQL[] {
  const facets = facetConditions(f);
  return [...baseConditions(userId, f), ...FACET_KEYS.flatMap((k) => (facets[k] ? [facets[k]] : []))];
}

function searchCondition(search: string | undefined): SQL | null {
  if (!search) return null;
  const { query, prefix } = splitSearch(search);
  if (!query && !prefix) return null;
  return sql`e.id IN (SELECT id FROM search_emails(${query}, ${prefix}, 200))`;
}

// ───────────────────────── keyset cursors ─────────────────────────

type CursorValue = string | number | null;

function encodeCursor(values: CursorValue[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined, arity: number): CursorValue[] | null {
  if (!cursor || cursor.length > 400) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(v) || v.length !== arity) return null;
    if (!v.every((x) => x === null || typeof x === "string" || typeof x === "number")) return null;
    return v as CursorValue[];
  } catch {
    return null;
  }
}

const isIso = (x: CursorValue): x is string => typeof x === "string" && !Number.isNaN(Date.parse(x));
const isUuid = (x: CursorValue): x is string =>
  typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);

interface SortPlan {
  order: SQL;
  after: (c: CursorValue[]) => SQL | null;
  arity: number;
  cursorOf: (r: InboxRow) => CursorValue[];
}

function sortPlan(sort: InboxFilters["sort"]): SortPlan {
  switch (sort) {
    case "oldest":
      return {
        order: sql`e.received_at ASC, e.id ASC`,
        arity: 2,
        after: ([t, id]) => (isIso(t!) && isUuid(id!) ? sql`(e.received_at, e.id) > (${t}::timestamptz, ${id}::uuid)` : null),
        cursorOf: (r) => [r.received_at.toISOString(), r.id],
      };
    case "score":
      return {
        order: sql`e.design_score DESC NULLS LAST, e.id DESC`,
        arity: 2,
        after: ([s, id]) => {
          if (!isUuid(id!)) return null;
          if (typeof s === "number") {
            return sql`((e.design_score < ${s}) OR (e.design_score = ${s} AND e.id < ${id}::uuid) OR e.design_score IS NULL)`;
          }
          return sql`(e.design_score IS NULL AND e.id < ${id}::uuid)`;
        },
        cursorOf: (r) => [r.design_score, r.id],
      };
    case "importance":
      return {
        order: sql`coalesce(e.importance_score, 0) DESC, e.received_at DESC, e.id DESC`,
        arity: 3,
        after: ([s, t, id]) =>
          typeof s === "number" && isIso(t!) && isUuid(id!)
            ? sql`(coalesce(e.importance_score, 0), e.received_at, e.id) < (${s}, ${t}::timestamptz, ${id}::uuid)`
            : null,
        cursorOf: (r) => [r.importance_score ?? 0, r.received_at.toISOString(), r.id],
      };
    case "deal_ending":
      return {
        order: sql`e.deal_ends_at ASC NULLS LAST, e.id ASC`,
        arity: 2,
        after: ([t, id]) => {
          if (!isUuid(id!)) return null;
          if (isIso(t!)) {
            return sql`((e.deal_ends_at > ${t}::timestamptz) OR (e.deal_ends_at = ${t}::timestamptz AND e.id > ${id}::uuid) OR e.deal_ends_at IS NULL)`;
          }
          return sql`(e.deal_ends_at IS NULL AND e.id > ${id}::uuid)`;
        },
        cursorOf: (r) => [r.deal_ends_at?.toISOString() ?? null, r.id],
      };
    case "newest":
    default:
      return {
        order: sql`e.received_at DESC, e.id DESC`,
        arity: 2,
        after: ([t, id]) => (isIso(t!) && isUuid(id!) ? sql`(e.received_at, e.id) < (${t}::timestamptz, ${id}::uuid)` : null),
        cursorOf: (r) => [r.received_at.toISOString(), r.id],
      };
  }
}

// ───────────────────────── queries ─────────────────────────

async function selectItems(db: Db, where: SQL[], order: SQL, limit: number): Promise<InboxRow[]> {
  const res = await raw(db).execute<InboxRow>(sql`
    SELECT ${INBOX_COLUMNS}
    FROM email e LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY ${order}
    LIMIT ${limit}`);
  return res.rows;
}

export async function listInbox(
  userId: string,
  filters: InboxFilters,
  opts: { cursor?: string | null; search?: string; limit?: number } = {},
): Promise<InboxPage> {
  const pool = await getPool();
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 100);
  const plan = sortPlan(filters.sort);
  const where = buildConditions(userId, filters);
  const search = searchCondition(opts.search);
  if (search) where.push(search);
  const cursor = decodeCursor(opts.cursor, plan.arity);
  const after = cursor ? plan.after(cursor) : null;
  const now = new Date();

  return withUser(pool, userId, async (db) => {
    const rows = await selectItems(db, after ? [...where, after] : where, plan.order, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    let pinned: InboxItem[] = [];
    if (!cursor && !filters.pinned && filters.done !== "done") {
      const pinnedRows = await selectItems(
        db,
        [...where, sql`e.pinned_at IS NOT NULL`, sql`e.done_at IS NULL`],
        sql`e.pinned_at DESC`,
        20,
      );
      pinned = pinnedRows.map((r) => toInboxItem(r, now));
    }
    return {
      items: page.map((r) => toInboxItem(r, now)),
      nextCursor: hasMore && last ? encodeCursor(plan.cursorOf(last)) : null,
      pinned,
    };
  });
}

// Facet counts are cached per (user, filters) for 30 s (DATA-MODEL.md §5).
const facetCache = new Map<string, { at: number; value: FacetCounts }>();
const FACET_TTL_MS = 30_000;

export async function facetCounts(userId: string, filters: InboxFilters, search?: string): Promise<FacetCounts> {
  const key = `${userId}:${JSON.stringify(filters)}:${search ?? ""}`;
  const hit = facetCache.get(key);
  if (hit && Date.now() - hit.at < FACET_TTL_MS) return hit.value;

  const pool = await getPool();
  const base = baseConditions(userId, filters);
  const sc = searchCondition(search);
  if (sc) base.push(sc);
  const facets = facetConditions(filters);
  /** AND of the selected facets other than `k` ("true" when none). */
  const othersThan = (k: FacetKey | null): SQL => {
    const conds = FACET_KEYS.filter((x) => x !== k).flatMap((x) => (facets[x] ? [facets[x]] : []));
    return conds.length ? sql.join(conds, sql` AND `) : sql`true`;
  };
  const fType = othersThan("types");
  const fImp = othersThan("importance");
  const fDesign = othersThan("design");
  const fIssues = othersThan("issues");
  const fDeals = othersThan("deals");
  const fAll = othersThan(null);

  const groupCounts = (Object.keys(TYPE_GROUPS) as TypeGroup[]).map(
    (g) => sql`count(*) FILTER (WHERE e.primary_type = ANY(${textArray(typesOf([g]))}) AND ${fType}) AS ${sql.raw(`"t_${g}"`)}`,
  );
  const designKeys: DesignFilter[] = ["good", "needs_work", "bad", "provisional", "plain_text", "not_analysed"];
  const issueKeys: DesignIssue[] = ["image_only", "contrast", "mobile", "clipped", "broken_images"];
  const dealKeys: DealFilter[] = ["active", "ending", "has_code"];

  const counts = await withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<Record<string, string>>(sql`
      SELECT
        count(*) FILTER (WHERE ${fAll}) AS total,
        count(*) FILTER (WHERE ${fAll} AND e.is_unread) AS unread,
        count(*) FILTER (WHERE ${fAll} AND e.suspicious) AS suspicious,
        ${sql.join(groupCounts, sql`, `)},
        count(*) FILTER (WHERE e.importance = 'high' AND ${fImp}) AS "i_high",
        count(*) FILTER (WHERE e.importance = 'normal' AND ${fImp}) AS "i_normal",
        count(*) FILTER (WHERE e.importance = 'low' AND ${fImp}) AS "i_low",
        ${sql.join(
          designKeys.map((k) => sql`count(*) FILTER (WHERE ${designCondition([k])!} AND ${fDesign}) AS ${sql.raw(`"d_${k}"`)}`),
          sql`, `,
        )},
        ${sql.join(
          issueKeys.map((k) => sql`count(*) FILTER (WHERE ${k} = ANY(e.design_issues) AND ${fIssues}) AS ${sql.raw(`"x_${k}"`)}`),
          sql`, `,
        )},
        ${sql.join(
          dealKeys.map((k) => sql`count(*) FILTER (WHERE ${dealCondition([k])!} AND ${fDeals}) AS ${sql.raw(`"q_${k}"`)}`),
          sql`, `,
        )}
      FROM email e LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE ${sql.join(base, sql` AND `)}`);
    return res.rows[0] ?? {};
  });

  const n = (k: string) => Number(counts[k] ?? 0);
  const value: FacetCounts = {
    total: n("total"),
    unread: n("unread"),
    suspicious: n("suspicious"),
    types: Object.fromEntries((Object.keys(TYPE_GROUPS) as TypeGroup[]).map((g) => [g, n(`t_${g}`)])),
    importance: { high: n("i_high"), normal: n("i_normal"), low: n("i_low") },
    design: Object.fromEntries(designKeys.map((k) => [k, n(`d_${k}`)])),
    issues: Object.fromEntries(issueKeys.map((k) => [k, n(`x_${k}`)])),
    deals: Object.fromEntries(dealKeys.map((k) => [k, n(`q_${k}`)])),
  };
  facetCache.set(key, { at: Date.now(), value });
  if (facetCache.size > 500) facetCache.delete(facetCache.keys().next().value as string);
  return value;
}

/** Font family options, grouped case-insensitively (DATA-MODEL.md §5 "Font family filter"). */
export async function fontOptions(userId: string, limit = 200): Promise<FontOption[]> {
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<{ k: string; label: string; n: string }>(sql`
      SELECT lower(f) AS k, mode() WITHIN GROUP (ORDER BY f) AS label, count(*) AS n
      FROM email e, unnest(e.font_families) f
      WHERE e.user_id = ${userId} AND NOT e.is_hidden
      GROUP BY 1 ORDER BY n DESC, 1 LIMIT ${Math.min(limit, 200)}`);
    return res.rows.map((r) => ({ key: r.k, label: r.label, count: Number(r.n) }));
  });
}

/** Counts for the sidebar's smart views (one scan). */
export async function smartViewCounts(userId: string): Promise<SmartViewCount[]> {
  const pool = await getPool();
  return withUser(pool, userId, async (db) => {
    const res = await raw(db).execute<Record<string, string>>(sql`
      SELECT ${sql.join(
        SMART_VIEWS.map((v) => sql`count(*) FILTER (WHERE ${viewCondition(v)}) AS ${sql.raw(`"${v}"`)}`),
        sql`, `,
      )}
      FROM email e LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
      WHERE e.user_id = ${userId} AND NOT e.is_hidden`);
    const row = res.rows[0] ?? {};
    return SMART_VIEWS.map((view) => ({ view, count: Number(row[view] ?? 0) }));
  });
}
