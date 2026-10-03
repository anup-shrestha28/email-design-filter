/**
 * The governor's image switch (FREE-TIER.md §8.2–8.3): when Fast Origin Transfer reaches its soft
 * level (or L1), friends' views load images only on a click; at its self-cap (or L2), everyone's
 * do. Read by the email page (queries/email.ts) and the gallery (actions/gallery.ts), so the main
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
  if (a.imagesClickToLoad === true || level >= 2) return true;
  return role !== "owner" && (a.friendsImagesClickToLoad === true || level >= 1);
}
