/**
 * Best-effort per-email byte budget (≤ 40 MB per email, split across that email's image tokens;
 * edf-app's view-source.ts EMAIL_BUDGET_BYTES, raised from FREE-TIER.md §8.4's 15 MB on
 * 2026-10-04 so a big animated GIF beside many small pictures loads). The signed per-token
 * allowance is the real control; this in-memory, per-instance ledger is a second layer. Bounded:
 * entries expire after the image tokens' longest life (14 days; tokens.ts) and the map never
 * exceeds MAX_ENTRIES (oldest evicted first).
 */
import { IMAGE_TOKEN_MAX_LIFETIME_SEC } from "./tokens";

export const EMAIL_BUDGET_BYTES = 40 * 1024 * 1024;
const TTL_MS = IMAGE_TOKEN_MAX_LIFETIME_SEC * 1000;
const MAX_ENTRIES = 10_000;

export class EmailBudget {
  readonly #used = new Map<string, { bytes: number; at: number }>();

  remaining(id: string, now: number): number {
    const e = this.#used.get(id);
    if (e === undefined || now - e.at > TTL_MS) return EMAIL_BUDGET_BYTES;
    return Math.max(0, EMAIL_BUDGET_BYTES - e.bytes);
  }

  spend(id: string, bytes: number, now: number): void {
    const e = this.#used.get(id);
    const fresh = e === undefined || now - e.at > TTL_MS;
    this.#used.delete(id);
    this.#used.set(id, { bytes: (fresh ? 0 : e.bytes) + bytes, at: fresh ? now : e.at });
    while (this.#used.size > MAX_ENTRIES) {
      const oldest = this.#used.keys().next().value;
      if (oldest === undefined) break;
      this.#used.delete(oldest);
    }
  }
}
