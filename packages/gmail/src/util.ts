/**
 * Small shared helpers: Gmail unit costs, a FIFO semaphore, base64url decoding and uint64
 * cursor comparison (cursors are compared as BigInt, never parsed to Number).
 */

/**
 * Gmail quota unit costs for projects created on or after 2026-05-01 (DESIGN.md §2 and §5.2,
 * RESEARCH-NOTES "NEW 2026 QUOTAS"). `messages.get` costs 20 whatever the format.
 */
export const UNITS = {
  getProfile: 1,
  historyList: 2,
  messagesList: 5,
  messagesGet: 20,
  attachmentsGet: 20,
  threadsGet: 40,
  watch: 100,
  stop: 50,
} as const;

/** A FIFO counting semaphore (≤ 4 concurrent Gmail requests per mailbox, DESIGN.md §5.2). */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Semaphore limit must be ≥ 1");
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  /** Requests currently holding a slot (for tests). */
  get inFlight(): number {
    return this.active;
  }
}

const B64 = /^[A-Za-z0-9_\-+/]*={0,2}$/;

/**
 * Decode Gmail's base64url (tolerates standard base64 and padding). Returns null for anything
 * that isn't base64, so garbage is detected instead of silently decoded to junk.
 */
export function decodeBase64Url(data: string): Buffer | null {
  if (!B64.test(data)) return null;
  return Buffer.from(data, "base64");
}

const UINT64 = /^\d{1,20}$/;
const UINT64_MAX = 18446744073709551615n;

/** True for a decimal uint64 string such as a Gmail historyId. */
export function isUint64(value: string): boolean {
  return UINT64.test(value) && BigInt(value) <= UINT64_MAX;
}

/** Compare two uint64 decimal strings exactly (no Number conversion). */
export function compareUint64(a: string, b: string): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The larger of two uint64 decimal strings, normalised (no leading zeros). */
export function maxUint64(a: string, b: string): string {
  return compareUint64(a, b) >= 0 ? BigInt(a).toString() : BigInt(b).toString();
}

/** Promise-based sleep (injectable in tests). */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
