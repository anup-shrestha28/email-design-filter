/**
 * Inbox filter state ⇄ URL (nuqs). Shared by the server page (createLoader) and client
 * components (useQueryStates). Free-text search is deliberately absent: it never enters the URL.
 */
import {
  createLoader,
  createSerializer,
  parseAsArrayOf,
  parseAsBoolean,
  parseAsString,
  parseAsStringLiteral,
  type inferParserType,
} from "nuqs/server";
import { SMART_VIEWS, type InboxFilters } from "@/server/queries/types";
import { parseFilters, TYPE_GROUP_KEYS } from "./filters";

const DESIGN = ["good", "needs_work", "bad", "provisional", "plain_text", "not_analysed"] as const;
const ISSUES = ["image_only", "contrast", "mobile", "clipped", "broken_images"] as const;
const IMPORTANCE = ["high", "normal", "low"] as const;
const FREQUENCY = ["daily", "several_weekly", "weekly", "monthly", "rare"] as const;
const DEALS = ["active", "ending", "has_code"] as const;
const DATES = ["24h", "7d", "30d", "90d"] as const;
const SORTS = ["newest", "oldest", "score", "importance", "deal_ending"] as const;
const SCOPES = ["subscriptions", "receipts", "all"] as const;

export const inboxParsers = {
  scope: parseAsStringLiteral(SCOPES).withDefault("subscriptions"),
  view: parseAsStringLiteral(SMART_VIEWS),
  types: parseAsArrayOf(parseAsStringLiteral(TYPE_GROUP_KEYS)).withDefault([]),
  subtypes: parseAsArrayOf(parseAsString).withDefault([]),
  importance: parseAsArrayOf(parseAsStringLiteral(IMPORTANCE)).withDefault([]),
  design: parseAsArrayOf(parseAsStringLiteral(DESIGN)).withDefault([]),
  issues: parseAsArrayOf(parseAsStringLiteral(ISSUES)).withDefault([]),
  fonts: parseAsArrayOf(parseAsString).withDefault([]),
  webFonts: parseAsBoolean.withDefault(false),
  senderId: parseAsString,
  newSenders: parseAsBoolean.withDefault(false),
  frequency: parseAsArrayOf(parseAsStringLiteral(FREQUENCY)).withDefault([]),
  stillSending: parseAsBoolean.withDefault(false),
  unread: parseAsBoolean.withDefault(false),
  notOpened: parseAsBoolean.withDefault(false),
  done: parseAsStringLiteral(["done", "not_done"] as const),
  pinned: parseAsBoolean.withDefault(false),
  deals: parseAsArrayOf(parseAsStringLiteral(DEALS)).withDefault([]),
  suspicious: parseAsBoolean.withDefault(false),
  date: parseAsStringLiteral(DATES),
  mailboxId: parseAsString,
  language: parseAsString,
  sort: parseAsStringLiteral(SORTS).withDefault("newest"),
};

/** Short, readable URL keys (e.g. /inbox?type=promotions,newsletters&design=bad). */
export const inboxUrlKeys = {
  types: "type",
  subtypes: "sub",
  importance: "imp",
  issues: "issue",
  fonts: "font",
  webFonts: "web",
  senderId: "sender",
  newSenders: "new",
  frequency: "freq",
  stillSending: "still",
  notOpened: "unopened",
  deals: "deal",
  suspicious: "sus",
  mailboxId: "mb",
  language: "lang",
} as const;

export type InboxParams = inferParserType<typeof inboxParsers>;

const loadParams = createLoader(inboxParsers, { urlKeys: inboxUrlKeys });

/** Server: URL search params → validated filters (invalid values fall back to defaults). */
export function filtersFromSearchParams(
  sp: Record<string, string | string[] | undefined>,
): InboxFilters {
  return parseFilters(loadParams(sp));
}

const serialize = createSerializer(inboxParsers, { urlKeys: inboxUrlKeys, clearOnDefault: true });

/** Build an /inbox link for a partial filter state (smart views, sender links, "see all"). */
export function inboxHref(params: Partial<InboxParams> = {}): `/inbox${string}` {
  return `/inbox${serialize(params)}` as `/inbox${string}`;
}

/** Number of active facet selections (for the "Filters (3)" button and "Clear all"). */
export function activeFilterCount(f: InboxFilters): number {
  return (
    f.types.length +
    f.subtypes.length +
    f.importance.length +
    f.design.length +
    f.issues.length +
    f.fonts.length +
    f.frequency.length +
    f.deals.length +
    (f.webFonts ? 1 : 0) +
    (f.senderId ? 1 : 0) +
    (f.newSenders ? 1 : 0) +
    (f.stillSending ? 1 : 0) +
    (f.unread ? 1 : 0) +
    (f.notOpened ? 1 : 0) +
    (f.done ? 1 : 0) +
    (f.pinned ? 1 : 0) +
    (f.suspicious ? 1 : 0) +
    (f.date ? 1 : 0) +
    (f.mailboxId ? 1 : 0) +
    (f.language ? 1 : 0)
  );
}
