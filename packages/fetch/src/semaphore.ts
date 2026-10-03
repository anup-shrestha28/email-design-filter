/**
 * In-memory per-host concurrency limit (DESIGN.md §11.7: ≤ 4 concurrent requests per host).
 * Entries are deleted when idle, so the map cannot grow without bound.
 */

interface Slot {
  active: number;
  waiters: Array<() => void>;
}

export class HostSemaphore {
  readonly #limit: number;
  readonly #slots = new Map<string, Slot>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Resolves with an idempotent release function; rejects if `signal` aborts while waiting. */
  acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = { active: 0, waiters: [] };
      this.#slots.set(key, slot);
    }
    const s = slot;
    const makeRelease = (): (() => void) => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = s.waiters.shift();
        if (next !== undefined) {
          next(); // hand the slot over directly
        } else {
          s.active--;
          if (s.active === 0) this.#slots.delete(key);
        }
      };
    };
    if (s.active < this.#limit) {
      s.active++;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve(makeRelease());
      };
      const onAbort = (): void => {
        const i = s.waiters.indexOf(grant);
        if (i >= 0) s.waiters.splice(i, 1);
        reject(signal.reason);
      };
      s.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Active requests for a host (tests). */
  active(key: string): number {
    return this.#slots.get(key)?.active ?? 0;
  }
}
