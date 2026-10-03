/**
 * Best-effort per-email byte budget (FREE-TIER.md §8.4: ≤ 15 MB per email, split across that
 * email's image tokens). The signed per-token allowance is the real control; this in-memory,
 * per-instance ledger is a second layer. Bounded: entries expire after 48 h (token lifetime) and
 * the map never exceeds MAX_ENTRIES (oldest evicted first).
 */
export const EMAIL_BUDGET_BYTES = 15 * 1024 * 1024;
const TTL_MS = 48 * 3600 * 1000;
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
