import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { GalleryView } from "@/components/gallery/gallery-view";
import { LiveGallery, liveStamp } from "@/components/gallery/live-gallery";
import { FlashToast } from "@/components/page/flash-toast";
import {
  galleryHref,
  isShownCategory,
  parseGalleryParams,
  type GalleryCategory,
  type GalleryParams,
} from "@/lib/gallery";
import { groupSimilar } from "@/lib/gallery-display";
import { galleryPreviewUrls } from "@/server/actions/gallery";
import { galleryFacets, listGallery } from "@/server/queries/gallery";
import type { GalleryPage as Page } from "@/server/queries/types";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Email designs" };

/** Short names a shared link may use for `?cat=` (the gallery's own key is `?category=`). */
const CAT_ALIASES: Record<string, GalleryCategory> = {
  orders: "receipts",
  updates: "product_updates",
  cart: "abandoned_cart",
  // Events merged into Promotions (2026-10-04): an old link still lands on them.
  events: "promotions",
};

/** How many cards get their preview URL minted with the page (the first screen at 1440 px). */
const SEEDED_PREVIEWS = 16;

/**
 * Preview URLs for the first screen of cards, minted now so those designs start loading as soon as
 * the page hydrates (no round trip first). The same Server Action the cards use, so the same
 * checks apply (own emails only, never security-sensitive or plain-text mail). Best effort: on any
 * failure the cards simply ask for their URLs themselves.
 */
async function previewSeed(page: Page) {
  const ids = groupSimilar(page.items)
    .map((g) => g.item)
    .filter((i) => i.previewable)
    .slice(0, SEEDED_PREVIEWS)
    .map((i) => i.id);
  if (ids.length === 0) return null;
  try {
    const mintedAt = Date.now();
    return { mintedAt, urls: await galleryPreviewUrls(ids) };
  } catch {
    return null;
  }
}

/**
 * `?cat=` (the spec's short key) → the canonical `?category=` URL, so a link written either way
 * filters the same and the chips show it. Null when there's nothing to rewrite.
 */
function canonicalCatUrl(sp: Record<string, string | string[] | undefined>): string | null {
  const cat = Array.isArray(sp.cat) ? sp.cat[0] : sp.cat;
  if (cat === undefined) return null;
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "cat" || v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
  }
  const id = cat.toLowerCase();
  const category = CAT_ALIASES[id] ?? id;
  // A category the gallery no longer shows (social, receipts…) leaves the link on All.
  if (isShownCategory(category) && !out.has("category")) out.set("category", category);
  const qs = out.toString();
  return qs ? `/gallery?${qs}` : "/gallery";
}

/** Query keys the gallery understands (filters, pages, the open card, the post-connect flash). */
const KNOWN_KEYS = new Set([
  "category",
  "design",
  "font",
  "q",
  "sort",
  "page",
  "size",
  "smin",
  "smax",
  "date",
  "since",
  "until",
  "sender",
  "problem",
  "mailbox",
  "webfonts",
  "board",
  "saved",
  "open",
  "connected",
]);
/**
 * Keys with a strict format: a value the gallery ignored or normalised (e.g. `?design=weird`,
 * `?page=0`, `?smin=90&smax=10`) is rewritten to the value actually applied.
 */
const STRICT_KEYS = [
  "category",
  "design",
  "sort",
  "page",
  "size",
  "smin",
  "smax",
  "date",
  "since",
  "until",
  "sender",
  "problem",
  "mailbox",
  "webfonts",
  "board",
  "saved",
] as const;

/** `href` plus the non-filter keys (`open`, `connected`) carried over from the request. */
function withExtras(href: string, sp: Record<string, string | string[] | undefined>): string {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const extra = new URLSearchParams();
  for (const k of ["open", "connected"] as const) {
    const v = first(sp[k]);
    if (v !== undefined) extra.set(k, v);
  }
  const tail = extra.toString();
  return tail ? `${href}${href.includes("?") ? "&" : "?"}${tail}` : href;
}

/**
 * The same URL without keys the gallery doesn't know and without values it ignored or normalised,
 * or null when it's already clean. The search text and font are left exactly as typed (trimming
 * them here would fight the search box).
 */
function cleanUrl(
  sp: Record<string, string | string[] | undefined>,
  params: GalleryParams,
): string | null {
  const canon = new URLSearchParams(galleryHref(params).split("?")[1] ?? "");
  const unknown = Object.keys(sp).some((k) => !KNOWN_KEYS.has(k));
  const ignored = STRICT_KEYS.some(
    (k) =>
      sp[k] !== undefined &&
      (Array.isArray(sp[k]) ? sp[k].join(",") : sp[k]) !== (canon.get(k) ?? undefined),
  );
  if (!unknown && !ignored) return null;
  return withExtras(galleryHref(params), sp);
}

/**
 * The main screen after sign-in: a gallery of email designs, already on screen with no click.
 * The page of designs asked for (`?page=`, `?size=`) and the filter counts are rendered here.
 */
export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const canonical = canonicalCatUrl(sp);
  if (canonical) redirect(canonical as Route);
  const params = parseGalleryParams(sp);
  const clean = cleanUrl(sp, params);
  if (clean) redirect(clean as Route);
  // The live gallery's baseline is read BEFORE the designs are listed: a design stored in between
  // then shows up as new on the first check instead of being missed (components/gallery/live-gallery.tsx).
  const stamp = liveStamp(user.userId);
  const [[page, seed], facets] = await Promise.all([
    stamp.then(() => listGallery(user.userId, params)).then(async (p) =>
      // A page past the end (fewer designs than the link expected) never mints previews: it redirects.
      p.page === params.page ? ([p, await previewSeed(p)] as const) : ([p, null] as const),
    ),
    galleryFacets(user.userId, params),
  ]);
  // Past the last page: show the last page, with the URL saying so.
  if (page.page !== params.page)
    redirect(withExtras(galleryHref({ ...params, page: page.page }), sp) as Route);
  const live = await stamp; // settled before the list started
  return (
    <>
      <h1 className="sr-only">Email designs</h1>
      {sp.connected === "1" ? (
        <FlashToast
          title="Gmail connected"
          description="Your first import is running in the background. Designs appear here as emails are checked."
        />
      ) : null}
      <GalleryView params={params} page={page} facets={facets} previewSeed={seed} />
      <LiveGallery stamp={live} params={params} page={page} />
    </>
  );
}
