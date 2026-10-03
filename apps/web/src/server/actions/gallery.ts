"use server";
/**
 * Design gallery Server Actions: lazily minted preview URLs. (Pages are numbered and rendered by
 * the gallery page itself from the URL, so there is no "load more" action.)
 *
 * Previews are only ever shown by edf-view (the viewer origin), never in the app origin: each URL
 * carries a signed, 240-second token for the caller's own email — "card" mode for the grid (only
 * the first few images go through edf-view's privacy proxy, FREE-TIER.md §8.4) and "img" mode for
 * the opened design (every image). The UI asks for URLs only when a card nears the viewport, and again
 * once they expire. Ids the caller doesn't own, security-sensitive and plain-text emails, and
 * emails in a disconnected mailbox never get a URL.
 */
import { previewAccess } from "../queries/gallery";
import { requireUserOrThrow } from "../session";
import { viewerUrl, viewTokenExpiry } from "../viewer-urls";

/**
 * Signed viewer URLs (valid 240 s) for up to 48 of the caller's own gallery emails, keyed by email
 * id. Ids that aren't the caller's, aren't previewable, aren't ids, or come after the 48th are
 * simply absent from the result.
 *
 * While the governor has made images click-to-load for the caller (FREE-TIER.md §8.2–8.3, the same
 * switch the email page honours), every URL is "noimg" — cards show the design without images and
 * the opened design shows a "Load images" button — unless `loadImages` is set: that button's own
 * request for one opened design ("img" mode only). The client reads the mode from the URL.
 */
export async function galleryPreviewUrls(
  ids: string[],
  mode: "card" | "img" = "card",
  opts: { loadImages?: boolean } = {},
): Promise<Record<string, string>> {
  const user = await requireUserOrThrow();
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  const wanted = mode === "img" ? "img" : "card"; // anything else from the client is a card
  const loadImages = wanted === "img" && opts?.loadImages === true && list.length === 1;
  const { ids: allowed, imagesOff } = await previewAccess(user.userId, user.role, list);
  const signed = imagesOff && !loadImages ? "noimg" : wanted;
  const exp = viewTokenExpiry();
  return Object.fromEntries(allowed.map((id) => [id, viewerUrl(user.userId, id, signed, exp)]));
}
