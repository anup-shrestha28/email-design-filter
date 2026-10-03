"use server";
/**
 * The live gallery's check (components/gallery/live-updates.tsx; FREE-TIER.md §4.4): read-only,
 * the caller's own designs only (RLS), metered like every Server Action (one invocation through
 * the session lookup). The client sends the stamp its page was rendered with and the page's
 * filters; the answer is the current stamp and, only when it moved, the page view's own counts.
 */
import { z } from "zod";
import { parseGalleryParams } from "@/lib/gallery";
import { sameStamp, type GalleryStamp, type ViewChange } from "@/lib/gallery-live";
import { toFailure, ok, type ActionResult } from "./result";
import { galleryStamp, galleryViewChange } from "../queries/gallery-live";
import { requireUserOrThrow } from "../session";

/** A Postgres timestamptz as text ("2026-09-30 14:00:00.983353+00"), as the stamp carries it. */
const pgTime = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/)
  .nullable();
const count = z.number().int().min(0).max(100_000_000);
const stampSchema = z.object({
  total: count,
  newest: pgTime,
  scored: count,
  typing: count,
  analyzedAt: pgTime,
  renderAt: pgTime,
});

export interface LiveCheck {
  stamp: GalleryStamp;
  /** The governor has UI polling off: stop checking (the page then behaves as before, §8.2). */
  pollingOff: boolean;
  /** Set only when the stamp differs from the one sent: the page view's counts against it. */
  view: ViewChange | null;
}

export async function checkGallery(input: {
  params: unknown;
  since: unknown;
}): Promise<ActionResult<LiveCheck>> {
  try {
    const user = await requireUserOrThrow();
    const since = stampSchema.parse(input?.since);
    const { stamp, pollingOff } = await galleryStamp(user.userId);
    if (sameStamp(stamp, since)) return ok({ stamp, pollingOff, view: null });
    const params = parseGalleryParams(input?.params);
    const view = await galleryViewChange(user.userId, params, since);
    return ok({ stamp, pollingOff, view });
  } catch (err) {
    return toFailure(err);
  }
}
