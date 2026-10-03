"use server";
/**
 * UI-only Server Actions for the app shell (command palette search, sync status polling).
 * Read-only: they call the existing query layer with the session user. Search text is only
 * ever passed as an action argument (POST body), never put into a URL.
 */
import { z } from "zod";
import { DEFAULT_FILTERS } from "@/lib/filters";
import { fail, ok, toFailure, type ActionResult } from "@/server/actions/result";
import { fontOptions, listInbox } from "@/server/queries/inbox";
import { getSyncStatus } from "@/server/queries/account";
import { listSenders } from "@/server/queries/senders";
import type { FontOption, InboxItem, SenderRow, SyncStatus } from "@/server/queries/types";
import { requireUserOrThrow } from "@/server/session";

export async function pollSyncStatus(): Promise<ActionResult<SyncStatus>> {
  try {
    const user = await requireUserOrThrow();
    return ok(await getSyncStatus(user.userId));
  } catch (err) {
    return toFailure(err);
  }
}

export interface PaletteResults {
  emails: InboxItem[];
  senders: SenderRow[];
  fonts: FontOption[];
}

const querySchema = z.string().trim().min(2).max(100);

export async function paletteSearch(query: string): Promise<ActionResult<PaletteResults>> {
  try {
    const user = await requireUserOrThrow();
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) return fail("Type at least two characters.", "invalid");
    const q = parsed.data;
    const [page, senders, fonts] = await Promise.all([
      listInbox(user.userId, { ...DEFAULT_FILTERS, scope: "all" }, { search: q, limit: 8 }),
      listSenders(user.userId, { search: q, limit: 5 }),
      fontOptions(user.userId, 200),
    ]);
    const lower = q.toLowerCase();
    return ok({
      emails: page.items,
      senders,
      fonts: fonts.filter((f) => f.key.startsWith(lower)).slice(0, 3),
    });
  } catch (err) {
    return toFailure(err);
  }
}
