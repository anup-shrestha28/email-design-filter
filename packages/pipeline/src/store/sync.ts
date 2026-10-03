/**
 * Apply one poll's history deltas in ONE transaction (FREE-TIER.md §4.2 step 4; DESIGN.md §5.6
 * steps 4–7): ledger inserts, race-safe label changes (or stashed deltas for ids not stored yet),
 * hard deletes, then the cursor compare-and-set. Runs inside `withUser`.
 */
import type { PoolClient } from "@edf/db";
import { applyLabelDelta, labelColumns } from "./record";

export interface AddedMessage {
  id: string;
  labelIds: string[];
}

export interface LabelChange {
  id: string;
  add: string[];
  remove: string[];
  /** History record id of the change (uint64 decimal string). */
  historyId: string;
}

export interface PollDelta {
  added: AddedMessage[];
  /**
   * Import storm (FREE-TIER.md §4.2 step 7): ids from the windowed `messages.list after:` listing
   * that replaces `added` — Q1 (category tabs) → full fetch, Q2 → metadata first.
   */
  listed?: { full: string[]; metadata: string[] };
  deleted: string[];
  labelChanges: LabelChange[];
  /** New cursor per the cursor rule (last processed record id when truncated). */
  newCursor: string;
  /** Paging stopped early; the next tick continues right away. */
  incomplete: boolean;
}

export interface ApplyResult {
  inserted: number;
  deleted: number;
  labelUpdates: number;
  stashed: number;
  refetch: number;
  cursorMoved: boolean;
}

const SKIP_LABELS = ["DRAFT", "SENT", "CHAT"];

function isCategory(labels: readonly string[]): boolean {
  return labels.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_UPDATES" || l === "CATEGORY_SOCIAL" || l === "CATEGORY_FORUMS");
}

export async function applyPollDelta(
  c: PoolClient,
  ctx: { userId: string; mailboxId: string; source: "sync" | "resync" | "reconcile"; nextPollAt: Date },
  d: PollDelta,
): Promise<ApplyResult> {
  const deletedSet = new Set(d.deleted);
  const out: ApplyResult = { inserted: 0, deleted: 0, labelUpdates: 0, stashed: 0, refetch: 0, cursorMoved: false };

  // 1. Ledger rows for new messages. Drafts/sent/chat and ids deleted in the same batch are dropped.
  //    Spam gets a content-free `skipped/spam` row (no fetch) so a later "not spam" can rescue it.
  //    Category mail is fetched in full directly; everything else metadata-first (DESIGN.md §5.6).
  const added = d.added.filter((m) => !deletedSet.has(m.id) && !m.labelIds.some((l) => SKIP_LABELS.includes(l)));
  // Ids whose ledger row this poll created: their labels are read at fetch time, so a label change
  // merged into their record needs no stash.
  const fresh = new Set<string>();
  for (let i = 0; i < added.length; i += 500) {
    const chunk = added.slice(i, i + 500);
    const res = await c.query<{ provider_message_id: string }>(
      `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, reason, source)
       SELECT $1, $2, x.id,
              CASE WHEN x.is_spam THEN 'skipped' WHEN x.is_full THEN 'pending_full' ELSE 'pending' END,
              CASE WHEN x.is_spam THEN 'spam' END, $3
       FROM unnest($4::text[], $5::boolean[], $6::boolean[]) AS x(id, is_full, is_spam)
       ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING
       RETURNING provider_message_id`,
      [
        ctx.mailboxId,
        ctx.userId,
        ctx.source,
        chunk.map((m) => m.id),
        chunk.map((m) => isCategory(m.labelIds)),
        chunk.map((m) => m.labelIds.includes("SPAM")),
      ],
    );
    out.inserted += res.rowCount ?? 0;
    for (const r of res.rows) fresh.add(r.provider_message_id);
  }
  for (const [ids, state] of [[d.listed?.full ?? [], "pending_full"], [d.listed?.metadata ?? [], "pending"]] as const) {
    const keep = ids.filter((id) => !deletedSet.has(id));
    for (let i = 0; i < keep.length; i += 500) {
      const res = await c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source)
         SELECT $1, $2, x, $3, $4 FROM unnest($5::text[]) x
         ON CONFLICT (mailbox_id, provider_message_id) DO NOTHING
         RETURNING provider_message_id`,
        [ctx.mailboxId, ctx.userId, state, ctx.source, keep.slice(i, i + 500)],
      );
      out.inserted += res.rowCount ?? 0;
      for (const r of res.rows as Array<{ provider_message_id: string }>) fresh.add(r.provider_message_id);
    }
  }

  // 2. Label changes: apply to stored rows race-safely; stash for known-but-not-stored ids.
  //    One batched lookup first drops ids with neither a ledger row nor an email (an import storm's
  //    dropped ids, mail never queued), so only known ids cost per-id statements.
  const candidates = d.labelChanges.filter((ch) => !deletedSet.has(ch.id) && !fresh.has(ch.id));
  const known = new Set<string>();
  const candidateIds = [...new Set(candidates.map((ch) => ch.id))];
  for (let i = 0; i < candidateIds.length; i += 1000) {
    const r = await c.query<{ id: string }>(
      `SELECT provider_message_id AS id FROM message_ledger WHERE mailbox_id = $1 AND provider_message_id = ANY($2::text[])
       UNION SELECT provider_message_id FROM email WHERE mailbox_id = $1 AND provider_message_id = ANY($2::text[])`,
      [ctx.mailboxId, candidateIds.slice(i, i + 1000)],
    );
    for (const row of r.rows) known.add(row.id);
  }
  const changes = candidates.filter((ch) => known.has(ch.id));
  for (const ch of changes) {
    // Lock the ledger row BEFORE looking for the email: a drain storing this message holds that lock
    // from its first statement to its commit, so we either see its committed email row here, or it
    // sees our stash when it starts. (Looking first could miss its uncommitted row and then stash a
    // delta it had already read past: the change was lost, and the cursor moved on.)
    const led = await c.query<{ state: string; reason: string | null; pending_label_delta: { add: string[]; remove: string[] } | null; delta_history_id: string | null }>(
      `SELECT state, reason, pending_label_delta, delta_history_id::text FROM message_ledger
       WHERE mailbox_id = $1 AND provider_message_id = $2 FOR UPDATE`,
      [ctx.mailboxId, ch.id],
    );
    const row = await c.query<{ id: string; label_ids: string[]; gmail_history_id: string }>(
      `SELECT id, label_ids, gmail_history_id::text FROM email WHERE mailbox_id = $1 AND provider_message_id = $2`,
      [ctx.mailboxId, ch.id],
    );
    const e = row.rows[0];
    if (e) {
      if (BigInt(e.gmail_history_id) >= BigInt(ch.historyId)) continue;
      const labels = applyLabelDelta(e.label_ids, ch.add, ch.remove);
      const f = labelColumns(labels);
      const upd = await c.query(
        `UPDATE email SET label_ids = $3, is_unread = $4, is_starred = $5, gmail_important = $6, gmail_category = $7,
                in_trash = $8, in_spam = $9, gmail_history_id = $10::numeric, updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2 AND gmail_history_id < $10::numeric`,
        [ctx.mailboxId, ch.id, labels, f.isUnread, f.isStarred, f.gmailImportant, f.gmailCategory, f.inTrash, f.inSpam, ch.historyId],
      );
      out.labelUpdates += upd.rowCount ?? 0;
      continue;
    }
    const l = led.rows[0];
    if (!l) continue; // unknown id: ignored (FREE-TIER.md §4.2 step 6)
    if (l.state === "skipped" && l.reason === "spam" && ch.remove.includes("SPAM")) {
      // Rescued from spam → fetch it again (DESIGN.md §5.3 re-evaluation).
      await c.query(
        `UPDATE message_ledger SET state = 'pending', reason = NULL, attempts = 0, next_attempt_at = NULL, updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2`,
        [ctx.mailboxId, ch.id],
      );
      out.refetch++;
      continue;
    }
    if (l.state === "pending" || l.state === "pending_full" || l.state === "failed") {
      const prev = l.pending_label_delta ?? { add: [], remove: [] };
      // Merge in history order: a later add cancels an earlier remove and vice versa.
      const add = [...prev.add.filter((x) => !ch.remove.includes(x)), ...ch.add.filter((x) => !prev.add.includes(x))];
      const remove = [...prev.remove.filter((x) => !ch.add.includes(x)), ...ch.remove.filter((x) => !prev.remove.includes(x))];
      const newer = !l.delta_history_id || BigInt(ch.historyId) > BigInt(l.delta_history_id);
      await c.query(
        `UPDATE message_ledger SET pending_label_delta = $3, delta_history_id = CASE WHEN $5 THEN $4::numeric ELSE delta_history_id END,
                updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2`,
        [ctx.mailboxId, ch.id, JSON.stringify({ add, remove }), ch.historyId, newer],
      );
      out.stashed++;
    }
  }

  // 3. Messages deleted in Gmail are hard-deleted here (cascades to analysis, deals, feedback).
  //    Ledger rows first: that waits for a drain storing one of them (it holds the row lock until
  //    commit), and the email DELETE after it then sees and removes the row that drain committed.
  //    A drain that starts later finds no ledger row and stores nothing (storeQueuedEmail).
  if (d.deleted.length) {
    for (let i = 0; i < d.deleted.length; i += 1000) {
      const chunk = d.deleted.slice(i, i + 1000);
      await c.query(`DELETE FROM message_ledger WHERE mailbox_id = $1 AND provider_message_id = ANY($2::text[])`, [ctx.mailboxId, chunk]);
      const del = await c.query(`DELETE FROM email WHERE mailbox_id = $1 AND provider_message_id = ANY($2::text[])`, [ctx.mailboxId, chunk]);
      out.deleted += del.rowCount ?? 0;
    }
  }

  // 4. Cursor compare-and-set, in the same transaction as the ledger inserts.
  const cas = await c.query(
    `UPDATE mailbox SET history_id = $2::numeric, updated_at = now()
     WHERE id = $1 AND (history_id IS NULL OR history_id < $2::numeric)`,
    [ctx.mailboxId, d.newCursor],
  );
  out.cursorMoved = (cas.rowCount ?? 0) > 0;
  await c.query(
    `UPDATE mailbox SET poll_incomplete = $2, next_poll_at = $3, last_synced_at = CASE WHEN $2 THEN last_synced_at ELSE now() END,
            sync_lease_until = NULL, updated_at = now()
     WHERE id = $1`,
    [ctx.mailboxId, d.incomplete, ctx.nextPollAt],
  );
  return out;
}

/** Take the poll row lease (FREE-TIER.md §4.2 step 1). Returns false if another worker holds it. */
export async function takeSyncLease(c: PoolClient, mailboxId: string, seconds = 240): Promise<boolean> {
  const r = await c.query(
    `UPDATE mailbox SET sync_lease_until = now() + make_interval(secs => $2)
     WHERE id = $1 AND status = 'active' AND (sync_lease_until IS NULL OR sync_lease_until < now())`,
    [mailboxId, seconds],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function releaseSyncLease(c: PoolClient, mailboxId: string): Promise<void> {
  await c.query("UPDATE mailbox SET sync_lease_until = NULL WHERE id = $1", [mailboxId]);
}
