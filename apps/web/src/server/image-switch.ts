/**
 * The governor's image switch (FREE-TIER.md §8.2–8.3): when Fast Origin Transfer reaches its soft
 * level, friends' views load images only on a click; at its self-cap, or when a shared Vercel
 * resource is within 10% of its hard limit, everyone's do. The governor's actions decide alone
 * (packages/budget governor.ts); its level (CPU or Neon pressure, L1–L3) never does (2026-11-05).
 * Read by the email page (queries/email.ts) and the gallery (actions/gallery.ts), so the main
 * screen can't keep proxying images through a budget emergency.
 */
export type GovernorImageValue =
  | {
      level?: number;
      actions?: { imagesClickToLoad?: boolean; friendsImagesClickToLoad?: boolean };
    }
  | null
  | undefined;

/** Images click-to-load for this role under the governor's switches. */
export function imagesClickToLoad(value: GovernorImageValue, role: "owner" | "friend"): boolean {
  const a = value?.actions ?? {};
  if (a.imagesClickToLoad === true) return true;
  return role !== "owner" && a.friendsImagesClickToLoad === true;
}
