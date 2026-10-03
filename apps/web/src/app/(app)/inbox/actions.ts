"use server";
/**
 * Inbox Server Actions: free-text search and keyset "load more" (search text travels in the
 * action body, never in the URL — DESIGN.md §9.2), plus the preview-pane detail fetch.
 */
import { z } from "zod";
import { parseFilters } from "@/lib/filters";
import { fail, ok, toFailure, type ActionResult } from "@/server/actions/result";
import { getEmailDetail } from "@/server/queries/email";
import { facetCounts, listInbox } from "@/server/queries/inbox";
import type { EmailDetail, FacetCounts, InboxPage } from "@/server/queries/types";
import { requireUserOrThrow } from "@/server/session";

const searchSchema = z.string().max(100).default("");
const cursorSchema = z.string().max(512).nullable().default(null);

export async function queryInbox(
  filters: unknown,
  search: string,
  cursor: string | null = null,
): Promise<ActionResult<{ page: InboxPage; counts: FacetCounts | null }>> {
  try {
    const user = await requireUserOrThrow();
    const f = parseFilters(filters);
    const q = searchSchema.parse(search).trim();
    const c = cursorSchema.parse(cursor);
    const [page, counts] = await Promise.all([
      listInbox(user.userId, f, { search: q || undefined, cursor: c }),
      c ? Promise.resolve(null) : facetCounts(user.userId, f, q || undefined),
    ]);
    return ok({ page, counts });
  } catch (err) {
    return toFailure(err);
  }
}

export async function getEmailPreview(emailId: string): Promise<ActionResult<EmailDetail>> {
  try {
    const user = await requireUserOrThrow();
    const id = z.string().uuid().parse(emailId);
    const detail = await getEmailDetail(user.userId, id, user.role);
    if (!detail) return fail("This email is no longer available.", "not_found");
    return ok(detail);
  } catch (err) {
    return toFailure(err);
  }
}
