/**
 * Inbox filter model shared by the client (URL state via nuqs) and the server (validation).
 * Free-text search is deliberately NOT part of this model: it never goes into the URL
 * (DESIGN.md §2 UI row, §9.2).
 */
import { z } from "zod";
import { EMAIL_SUBTYPES, TYPE_GROUPS, type TypeGroup } from "@edf/core/types";
import type { InboxFilters, SmartView } from "@/server/queries/types";
import { SMART_VIEWS } from "@/server/queries/types";

export const TYPE_GROUP_KEYS = Object.keys(TYPE_GROUPS) as TypeGroup[];

export const TYPE_GROUP_LABELS: Record<TypeGroup, string> = {
  promotions: "Promotions",
  newsletters: "Newsletters",
  updates: "Updates",
  orders: "Orders & receipts",
  security: "Security",
  notifications: "Notifications",
  events: "Events",
  other: "Other",
};

export const SMART_VIEW_LABELS: Record<SmartView, string> = {
  needs_attention: "Needs attention",
  deals_ending: "Deals ending soon",
  security: "Security & account",
  suspicious: "Suspicious",
  newsletters_i_read: "Newsletters I read",
  best_designed: "Best designed",
  bad_design: "Bad design",
  new_senders: "New senders",
  cleanup_never_opened: "Cleanup: never opened",
  still_sending: "Unsubscribed but still sending",
};

/**
 * Limits shared with the facet rail, so the UI can never build a selection the server rejects.
 * MAX_FONT_NAME sits above the design package's 500-char cut of a `font-family` value, so every
 * family name stored in `email.font_families` (and so every rail or command-palette option) fits.
 */
export const MAX_FONTS = 20;
export const MAX_FONT_NAME = 512;
const MAX_SUBTYPES = new Set(Object.values(EMAIL_SUBTYPES).flat()).size;

/** Font picks the server accepts (≤ MAX_FONTS names of ≤ MAX_FONT_NAME chars); picks past the cap are ignored. */
export function capFonts(fonts: readonly string[]): string[] {
  return fonts.filter((f) => f.length > 0 && f.length <= MAX_FONT_NAME).slice(0, MAX_FONTS);
}

const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z.array(z.enum(values)).max(values.length).default([]);

export const inboxFiltersSchema = z.object({
  scope: z.enum(["subscriptions", "receipts", "all"]).default("subscriptions"),
  view: z.enum(SMART_VIEWS).nullable().default(null),
  types: csv(TYPE_GROUP_KEYS as [TypeGroup, ...TypeGroup[]]),
  subtypes: z
    .array(z.string().regex(/^[a-z_]{1,32}$/))
    .max(MAX_SUBTYPES)
    .default([]),
  importance: csv(["high", "normal", "low"] as const),
  design: csv(["good", "needs_work", "bad", "provisional", "plain_text", "not_analysed"] as const),
  issues: csv(["image_only", "contrast", "mobile", "clipped", "broken_images"] as const),
  fonts: z.array(z.string().min(1).max(MAX_FONT_NAME)).max(MAX_FONTS).default([]),
  webFonts: z.boolean().default(false),
  senderId: z.string().uuid().nullable().default(null),
  newSenders: z.boolean().default(false),
  frequency: csv(["daily", "several_weekly", "weekly", "monthly", "rare"] as const),
  stillSending: z.boolean().default(false),
  unread: z.boolean().default(false),
  notOpened: z.boolean().default(false),
  done: z.enum(["done", "not_done"]).nullable().default(null),
  pinned: z.boolean().default(false),
  deals: csv(["active", "ending", "has_code"] as const),
  suspicious: z.boolean().default(false),
  date: z.enum(["24h", "7d", "30d", "90d"]).nullable().default(null),
  mailboxId: z.string().uuid().nullable().default(null),
  language: z
    .string()
    .regex(/^[a-z]{2}$/)
    .nullable()
    .default(null),
  sort: z.enum(["newest", "oldest", "score", "importance", "deal_ending"]).default("newest"),
}) satisfies z.ZodType<InboxFilters, unknown>;

export const DEFAULT_FILTERS: InboxFilters = inboxFiltersSchema.parse({});

/**
 * Parse untrusted filter input; anything invalid falls back to defaults field by field. Invalid
 * items of a list are dropped (the rest of the list is kept); a list of distinct items that is still
 * over its limit keeps its first items up to the limit (a list padded with repeats falls back to its
 * default). One bad value never discards the other filters.
 */
export function parseFilters(input: unknown): InboxFilters {
  const whole = inboxFiltersSchema.safeParse(input ?? {});
  if (whole.success) return whole.data;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return DEFAULT_FILTERS;
  const raw = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(inboxFiltersSchema.shape)) {
    const value = raw[key];
    const r = field.safeParse(value);
    if (r.success) {
      out[key] = r.data;
      continue;
    }
    // A list item is valid iff a one-item list of it parses (every list limit is ≥ 1). With only
    // valid, distinct items left, the only remaining limit is the length, so keep the longest head
    // that parses. A list padded with repeats is malformed and falls back to its default.
    const kept = Array.isArray(value) ? value.filter((v) => field.safeParse([v]).success) : null;
    const distinct = kept !== null && new Set(kept).size === kept.length;
    const head = kept && distinct ? kept.slice(0, longestValidHead(field, kept)) : kept;
    const retry = head ? field.safeParse(head) : null;
    out[key] = retry?.success ? retry.data : DEFAULT_FILTERS[key as keyof InboxFilters];
  }
  return out as unknown as InboxFilters;
}

/** Largest n with `field` accepting list.slice(0, n), or 0 (the caller then re-checks the result). */
function longestValidHead(field: z.ZodType, list: unknown[]): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (field.safeParse(list.slice(0, mid)).success) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Punctuation kept inside the prefix word: Postgres indexes "rust-embedded", "acme/api" and
 * "bob@example.com" as whole words, so stripping it would make them unfindable. Never a quote or
 * backslash (the word is passed to to_tsquery via quote_literal). */
const PREFIX_DROP = /[^\p{L}\p{N}\-./@_+]/gu;
const PREFIX_EDGE = /^[-./@_+]+|[-./@_+]+$/gu;

/**
 * Search input rules: ≤ 100 chars; the last token becomes a prefix match (letters/digits plus
 * inner - . / @ _ +, so hyphenated words, paths, domains and addresses still match).
 */
export function splitSearch(q: string): { query: string; prefix: string } {
  const trimmed = q.normalize("NFKC").slice(0, 100).trim();
  if (!trimmed) return { query: "", prefix: "" };
  const endsWithSpace = /\s$/.test(q);
  const parts = trimmed.split(/\s+/);
  const last = endsWithSpace ? "" : (parts.pop() ?? "");
  const prefix = last
    .replace(PREFIX_DROP, "")
    .replace(PREFIX_EDGE, "")
    .toLowerCase()
    .slice(0, 40)
    .replace(PREFIX_EDGE, "");
  return { query: parts.join(" "), prefix };
}
