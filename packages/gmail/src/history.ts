/**
 * Incremental sync from Gmail history (FREE-TIER.md §4.2 steps 3–7, §4.4; DESIGN.md §5.6).
 * Pure and DB-free: it pages `history.list`, merges the changes per message id, and computes
 * the next cursor with the no-lost-mail rule. The caller applies the result in one
 * transaction (ledger inserts, race-safe label deltas, hard deletes, cursor CAS).
 *
 * Cursor rule (§4.2 step 5):
 *  - Paging stopped early (a `nextPageToken` remains) ⇒ `newCursor` = the `id` of the last
 *    History record processed — never the response's top-level `historyId`, which is the
 *    mailbox's *current* id and would skip every record on the pages we didn't read.
 *  - Paging finished ⇒ `newCursor` = the response `historyId`. With more than one page we use
 *    the *first* page's `historyId` (DECISIONS.md G2): records created while we were paging may
 *    be missing from a snapshot-pinned listing, and re-reading a few records is harmless
 *    (every apply step is idempotent) while skipping them is not.
 */
import type { GmailCategory } from "@edf/core";
import { HISTORY_TYPES, type GmailClient } from "./client";
import { GmailError } from "./errors";
import type { HistoryRecord } from "./schemas";
import { compareUint64, isUint64, maxUint64 } from "./util";

/** What the pipeline should do with one message id after this poll. */
export type HistoryAction = "insert" | "skip" | "delete" | "labels";
export type HistorySkipReason = "draft" | "sent" | "chat" | "spam";

export interface HistoryDelta {
  messageId: string;
  threadId: string | null;
  /**
   * The id of the last History record that touched this message (uint64 decimal string).
   * Use it as `h` in the race-safe label update `… WHERE gmail_history_id < h`
   * (DATA-MODEL.md §5) and as `delta_history_id` when stashing a pending delta.
   */
  historyId: string;
  /**
   * - `insert`: new message → ledger row (`pending`; route `CATEGORY_*` to full, DESIGN §5.6 step 4).
   * - `skip`: new message pre-filtered by its labels (DRAFT/SENT/CHAT, or SPAM) → ledger
   *   `skipped` with `skipReason`. Keep SPAM rows: a later SPAM removal re-fetches them.
   * - `delete`: permanently deleted in Gmail → hard delete (supersedes everything else).
   * - `labels`: label changes on a message not added in this poll → apply race-safely to a
   *   stored email, stash on a ledger row that isn't stored yet, ignore if unknown (§4.2 step 6).
   */
  action: HistoryAction;
  skipReason: HistorySkipReason | null;
  /** Seen in `messagesAdded` in this poll. */
  added: boolean;
  /**
   * The message's label set as of its `messagesAdded` record with this poll's later changes
   * applied, or null when history carried no `labelIds` (then the fetch step filters).
   */
  labelIds: string[] | null;
  /** Net label changes in this poll (the last operation per label wins); disjoint sets. */
  labelsAdded: string[];
  labelsRemoved: string[];
  /**
   * SPAM was removed (and not re-added) on a message not added in this poll: a `skipped`
   * (spam) ledger row must be deleted and re-fetched (DESIGN.md §5.3). SPAM *added* is just a
   * label delta that sets `in_spam` (hidden from view).
   */
  refetch: boolean;
}

export interface PollHistoryOptions {
  /** The stored cursor (uint64 decimal string). */
  startHistoryId: string;
  /** Page cap: 2 for sync-on-open (§4.4); the tick pages until its time budget runs out. */
  maxPages: number;
  /** Absolute deadline in epoch ms: no new page is requested at or after it. */
  deadlineMs: number;
  now?: () => number;
  /** Default 500 (§4.2 step 3). */
  maxResults?: number;
}

export interface PollHistoryResult {
  /** One merged delta per message id, in first-seen order. */
  records: HistoryDelta[];
  /** The cursor to CAS into `mailbox.history_id` (uint64 decimal string). */
  newCursor: string;
  /** False ⇒ set `mailbox.poll_incomplete = true`; the next tick continues right away. */
  complete: boolean;
  /** Distinct message ids seen in `messagesAdded`. */
  addedCount: number;
  /** More than 2,000 `messagesAdded` ⇒ switch to a windowed `messages.list after:` (§4.2 step 7). */
  importStorm: boolean;
  pages: number;
  /** Id of the last History record processed (null if none). */
  lastRecordId: string | null;
}

export const IMPORT_STORM_THRESHOLD = 2000;

interface Acc {
  messageId: string;
  threadId: string | null;
  historyId: string;
  added: boolean;
  deleted: boolean;
  labelSet: string[] | null;
  ops: Map<string, "add" | "remove">;
  spamRemoved: boolean;
}

/**
 * Poll history from `startHistoryId`, applying the cursor rule. Throws
 * `GmailError("history_expired")` on a 404 (the caller starts a resync, §4.2 step 9).
 */
export async function pollHistory(
  client: Pick<GmailClient, "historyList">,
  opts: PollHistoryOptions,
): Promise<PollHistoryResult> {
  const { startHistoryId, deadlineMs } = opts;
  if (!isUint64(startHistoryId))
    throw new TypeError("pollHistory: startHistoryId must be a uint64 string");
  if (!Number.isInteger(opts.maxPages) || opts.maxPages < 1)
    throw new RangeError("pollHistory: maxPages ≥ 1");
  const now = opts.now ?? Date.now;
  const acc = new Map<string, Acc>();
  let pageToken: string | undefined;
  let pages = 0;
  let firstPageHistoryId: string | null = null;
  let lastRecordId: string | null = null;
  let outOfOrder = false;

  for (;;) {
    const resp = await client.historyList({
      startHistoryId,
      pageToken,
      maxResults: opts.maxResults ?? 500,
      historyTypes: HISTORY_TYPES,
    });
    pages++;
    firstPageHistoryId ??= resp.historyId;
    for (const rec of resp.history ?? []) {
      if (lastRecordId !== null && compareUint64(rec.id, lastRecordId) < 0) outOfOrder = true;
      applyRecord(acc, rec);
      lastRecordId = rec.id;
    }

    if (!resp.nextPageToken) {
      const finished = pages === 1 ? resp.historyId : firstPageHistoryId;
      return finish(acc, maxUint64(startHistoryId, finished), true, pages, lastRecordId);
    }
    // Keep paging past the page cap while no record has been processed yet, so an empty
    // first page can never pin the cursor forever; the deadline still bounds the poll.
    const capReached = pages >= opts.maxPages && lastRecordId !== null;
    if (capReached || now() >= deadlineMs) {
      if (outOfOrder) {
        // "The last record processed" is only a safe cursor if records arrive in ascending
        // order (Gmail documents chronological order). Refuse to guess.
        throw new GmailError("bad_response", {
          method: "users.history.list",
          reason: "history_out_of_order",
        });
      }
      const cursor =
        lastRecordId === null ? startHistoryId : maxUint64(startHistoryId, lastRecordId);
      return finish(acc, cursor, false, pages, lastRecordId);
    }
    pageToken = resp.nextPageToken;
  }
}

function applyRecord(acc: Map<string, Acc>, rec: HistoryRecord): void {
  const touch = (msg: { id: string; threadId?: string | undefined }): Acc => {
    let a = acc.get(msg.id);
    if (!a) {
      a = {
        messageId: msg.id,
        threadId: msg.threadId ?? null,
        historyId: rec.id,
        added: false,
        deleted: false,
        labelSet: null,
        ops: new Map(),
        spamRemoved: false,
      };
      acc.set(msg.id, a);
    } else {
      a.historyId = maxUint64(a.historyId, rec.id);
      a.threadId ??= msg.threadId ?? null;
    }
    return a;
  };

  for (const { message } of rec.messagesAdded ?? []) {
    const a = touch(message);
    a.added = true;
    if (message.labelIds) {
      a.labelSet = applyLabelDelta(message.labelIds, [], []);
      // Changes recorded before the add (only possible when re-reading overlapping records)
      // are already reflected in the fresh label set.
      for (const [label, op] of a.ops) {
        a.labelSet =
          op === "add"
            ? applyLabelDelta(a.labelSet, [label], [])
            : applyLabelDelta(a.labelSet, [], [label]);
      }
    }
  }
  for (const { message } of rec.messagesDeleted ?? []) touch(message).deleted = true;
  for (const change of rec.labelsAdded ?? []) {
    const a = touch(change.message);
    for (const label of change.labelIds ?? []) {
      a.ops.set(label, "add");
      if (a.labelSet) a.labelSet = applyLabelDelta(a.labelSet, [label], []);
      if (label === "SPAM") a.spamRemoved = false;
    }
  }
  for (const change of rec.labelsRemoved ?? []) {
    const a = touch(change.message);
    for (const label of change.labelIds ?? []) {
      a.ops.set(label, "remove");
      if (a.labelSet) a.labelSet = applyLabelDelta(a.labelSet, [], [label]);
      if (label === "SPAM") a.spamRemoved = true;
    }
  }
}

function finish(
  acc: Map<string, Acc>,
  newCursor: string,
  complete: boolean,
  pages: number,
  lastRecordId: string | null,
): PollHistoryResult {
  const records: HistoryDelta[] = [];
  let addedCount = 0;
  for (const a of acc.values()) {
    if (a.added) addedCount++;
    const labelsAdded: string[] = [];
    const labelsRemoved: string[] = [];
    for (const [label, op] of a.ops) (op === "add" ? labelsAdded : labelsRemoved).push(label);
    let action: HistoryAction;
    let skipReason: HistorySkipReason | null = null;
    if (a.deleted) action = "delete";
    else if (a.added) {
      skipReason = a.labelSet ? skipReasonFor(a.labelSet) : null;
      action = skipReason ? "skip" : "insert";
    } else action = "labels";
    records.push({
      messageId: a.messageId,
      threadId: a.threadId,
      historyId: a.historyId,
      action,
      skipReason,
      added: a.added,
      labelIds: a.labelSet,
      labelsAdded,
      labelsRemoved,
      refetch: !a.deleted && !a.added && a.spamRemoved,
    });
  }
  return {
    records,
    newCursor,
    complete,
    addedCount,
    importStorm: addedCount > IMPORT_STORM_THRESHOLD,
    pages,
    lastRecordId,
  };
}

/** DESIGN.md §5.6 step 4 / §5.5 step 1: DRAFT, SENT, CHAT and SPAM are never fetched. */
export function skipReasonFor(labelIds: readonly string[]): HistorySkipReason | null {
  if (labelIds.includes("DRAFT")) return "draft";
  if (labelIds.includes("SENT")) return "sent";
  if (labelIds.includes("CHAT")) return "chat";
  if (labelIds.includes("SPAM")) return "spam";
  return null;
}

export interface LabelFlags {
  isUnread: boolean;
  isStarred: boolean;
  gmailImportant: boolean;
  inTrash: boolean;
  inSpam: boolean;
  gmailCategory: GmailCategory | null;
  isDraft: boolean;
  isSent: boolean;
  isChat: boolean;
}

const CATEGORY_LABELS: ReadonlyArray<readonly [string, GmailCategory]> = [
  ["CATEGORY_PROMOTIONS", "promotions"],
  ["CATEGORY_UPDATES", "updates"],
  ["CATEGORY_SOCIAL", "social"],
  ["CATEGORY_FORUMS", "forums"],
  ["CATEGORY_PERSONAL", "personal"],
];

/** Map Gmail system labels to the `email` flag columns (DATA-MODEL.md §3). */
export function labelFlags(labelIds: readonly string[]): LabelFlags {
  const has = new Set(labelIds);
  const category = CATEGORY_LABELS.find(([label]) => has.has(label));
  return {
    isUnread: has.has("UNREAD"),
    isStarred: has.has("STARRED"),
    gmailImportant: has.has("IMPORTANT"),
    inTrash: has.has("TRASH"),
    inSpam: has.has("SPAM"),
    gmailCategory: category ? category[1] : null,
    isDraft: has.has("DRAFT"),
    isSent: has.has("SENT"),
    isChat: has.has("CHAT"),
  };
}

/**
 * Apply a label delta: remove first, then add; order preserved, duplicates dropped. For the net
 * deltas of a `HistoryDelta` the two sets are disjoint, so the order doesn't matter.
 */
export function applyLabelDelta(
  labels: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const removeSet = new Set(remove);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of labels) {
    if (removeSet.has(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  for (const l of add) {
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}
