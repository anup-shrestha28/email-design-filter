"use server";
/** Sender search for the Senders table (search text travels in the action body, never the URL). */
import { z } from "zod";
import { ok, toFailure, type ActionResult } from "@/server/actions/result";
import { listSenders, type SenderFilter } from "@/server/queries/senders";
import type { SenderRow } from "@/server/queries/types";
import { requireUserOrThrow } from "@/server/session";

const FILTERS = [
  "all",
  "new",
  "muted",
  "still_sending",
  "never_opened",
  "no_unsubscribe",
] as const satisfies readonly SenderFilter[];

export async function searchSenders(
  search: string,
  filter: string,
): Promise<ActionResult<SenderRow[]>> {
  try {
    const user = await requireUserOrThrow();
    const q = z.string().max(100).parse(search).trim();
    const f = z.enum(FILTERS).catch("all").parse(filter);
    return ok(await listSenders(user.userId, { search: q || undefined, filter: f }));
  } catch (err) {
    return toFailure(err);
  }
}
