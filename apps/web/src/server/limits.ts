/** Per-user product limits (FREE-TIER.md §5.3, §6.1; DESIGN.md §11.8). */
export const ON_DEMAND_LIMITS = {
  owner: { renders: 5, aiReviews: 5 },
  friend: { renders: 1, aiReviews: 1 },
} as const;

/** Sync-on-open throttle (FREE-TIER.md §4.4). */
export const SYNC_ON_OPEN_MIN_INTERVAL_MS = 2 * 60 * 1000;
/** At governor L2, friends may sync on open at most every 2 hours. */
export const SYNC_ON_OPEN_FRIEND_L2_MS = 2 * 60 * 60 * 1000;
/** At most 2 mailboxes per user (DESIGN.md §11.8). */
export const MAX_MAILBOXES_PER_USER = 2;
