/**
 * The governor's image switch (FREE-TIER.md §8.2–8.3): when Fast Origin Transfer reaches its soft
 * level, friends' views load images only on a click; at its self-cap (or the L3 freeze),
 * everyone's do. CPU or Neon pressure (L1/L2) no longer turns pictures off (2026-10-08): the
 * governor's own actions decide (packages/budget governor.ts), and only L3 is read from the level. Read by the email page (queries/email.ts) and the gallery (actions/gallery.ts), so the main
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
  const level = Number(value?.level ?? 0);
  const a = value?.actions ?? {};
  if (a.imagesClickToLoad === true || level >= 3) return true;
  return role !== "owner" && a.friendsImagesClickToLoad === true;
}
