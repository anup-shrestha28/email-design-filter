/**
 * Opus 5 spend caps and pricing (FREE-TIER.md §6.2–6.5). Every call or batch reserves its
 * worst case through `reserve_llm(p_user, p_usd, p_day, p_global_cap, p_month_cap, p_day_cap)`
 * and settles from `usage` afterwards (`settle_llm`). Amounts are numeric(10,4) in Postgres:
 * caps round *down* and prices round *up*, so rounding can never overspend.
 */

/** `claude-opus-5` list prices, USD per million tokens (FREE-TIER §2, §6.3). */
export const OPUS5_PRICES_PER_MTOK = {
  input: 5,
  output: 25,
  cacheRead: 0.5,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
} as const;

/** Message Batches: 50% off, stacking with prompt caching. */
export const BATCH_DISCOUNT = 0.5;

const floor4 = (x: number) => Math.floor(x * 10_000 + 1e-7) / 10_000;
const ceil4 = (x: number) => (x <= 0 ? 0 : Math.ceil(x * 10_000 - 1e-7) / 10_000);

export interface LlmCapsInput {
  /** G: the Console monthly spend limit (`app_setting.ai.cap_usd`, default 5). */
  G: number;
  role: "owner" | "friend";
  /** Users active this month, including the owner. */
  activeUsers: number;
  /** Friends active this month. */
  activeFriends: number;
  /** `llm_budget_global.reserved_usd` for the month. */
  globalReservedUsd: number;
  /**
   * The owner's month reservations (`llm_owner_month_reserved`), for the friends' equal split.
   * Default: all of `globalReservedUsd` (conservative).
   */
  ownerMonthReservedUsd?: number;
}

export interface LlmCaps {
  /**
   * `reserve_llm`'s ceiling on the month's global reservations: 0.9 × G, less, for a friend, the
   * part of the owner's hold the owner hasn't reserved yet.
   */
  globalCap: number;
  monthCap: number;
  dayCap: number;
}

/**
 * Held back from the friends for the owner (FREE-TIER §6.4 "You 100%"): the owner's uncapped
 * steady month, $1.6 at any G. The friends' shares then match §6.4: ≈ $0.15 at 20 users and G = 5,
 * ≈ $0.39 at G = 10; at 5 users the $0.50 (G/5-scaled) friend cap binds first.
 */
export const OWNER_MONTH_HOLD_USD = 1.6;

/**
 * Caps for one user (FREE-TIER §6.5 layer 3):
 *  - global: 0.9 × G;
 *  - owner: $3/month and $0.50/day; while the owner is the only active user, the monthly cap is
 *    the global cap (the day cap stays $0.50);
 *  - friend: $0.50/month and $0.10/day at G = $5, scaled by G/5;
 *  - near the global cap the budget is split equally among active friends: each friend's month
 *    cap is at most `(global cap − owner's hold) / activeFriends`, where the hold is the larger of
 *    the owner's reservations and `OWNER_MONTH_HOLD_USD`. The share doesn't grow with the friend's
 *    own reservations, so repeated reservations can't take more than it;
 *  - a friend's global cap leaves the part of the hold the owner hasn't reserved yet, so the
 *    friends together can't take it (early in the month, or when more friends become active).
 */
export function llmCaps(p: LlmCapsInput): LlmCaps {
  if (!Number.isFinite(p.G) || p.G < 0)
    throw new RangeError("llmCaps: G must be a finite number ≥ 0");
  const globalCap = floor4(0.9 * p.G);
  if (p.role === "owner") {
    const monthCap = p.activeUsers <= 1 ? globalCap : floor4(Math.min(3, globalCap));
    return { globalCap, monthCap, dayCap: floor4(Math.min(0.5, monthCap)) };
  }
  const scale = p.G / 5;
  const baseMonth = 0.5 * scale;
  const baseDay = 0.1 * scale;
  const globalReserved = Math.max(0, p.globalReservedUsd);
  const owner = Math.min(globalReserved, Math.max(0, p.ownerMonthReservedUsd ?? globalReserved));
  const hold = Math.min(OWNER_MONTH_HOLD_USD, globalCap);
  const share = Math.max(0, globalCap - Math.max(owner, hold)) / Math.max(1, Math.floor(p.activeFriends));
  const monthCap = floor4(Math.min(baseMonth, share));
  // Without the owner's figure, none of the hold counts as reserved (conservative here too).
  const unreservedHold = Math.max(0, hold - (p.ownerMonthReservedUsd === undefined ? 0 : owner));
  return {
    globalCap: floor4(globalCap - unreservedHold),
    monthCap,
    dayCap: floor4(Math.min(baseDay, monthCap)),
  };
}

export type CacheTtl = "5m" | "1h";

export interface PriceRequestInput {
  /** Exact input tokens from `count_tokens` (the whole prompt, including the cached prefix). */
  inputTokens: number;
  /** Tokens of the prefix marked with `cache_control` (priced as a cache *write*, worst case). */
  cachedPrefixTokens?: number;
  /** TTL of the cache breakpoint; null/undefined = no caching. */
  cacheTtl?: CacheTtl | null;
  /** `max_tokens` (thinking included), priced at the output rate. */
  maxTokens: number;
  batch?: boolean;
}

function assertTokens(name: string, n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${name} must be a non-negative integer`);
}

/**
 * Worst-case USD for a reservation (FREE-TIER §6.5): uncached input at $5/MTok, the cached
 * prefix as a cache write ($6.25 for 5 min, $10 for 1 h), `max_tokens` at $25/MTok, halved for
 * Batch. Rounded up to 4 decimals and never 0 (reserve_llm requires p_usd > 0).
 */
export function priceRequest(p: PriceRequestInput): number {
  const cached = p.cachedPrefixTokens ?? 0;
  assertTokens("inputTokens", p.inputTokens);
  assertTokens("cachedPrefixTokens", cached);
  assertTokens("maxTokens", p.maxTokens);
  if (cached > p.inputTokens) throw new RangeError("cachedPrefixTokens cannot exceed inputTokens");
  const P = OPUS5_PRICES_PER_MTOK;
  const prefixRate =
    !p.cacheTtl || cached === 0 ? P.input : p.cacheTtl === "1h" ? P.cacheWrite1h : P.cacheWrite5m;
  let usd =
    ((p.inputTokens - cached) * P.input + cached * prefixRate + p.maxTokens * P.output) / 1e6;
  if (p.batch) usd *= BATCH_DISCOUNT;
  return Math.max(0.0001, ceil4(usd));
}

/** The Messages API `usage` object (fields we price). */
export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

/**
 * Actual USD from a response's `usage`, for settlement and metering. Cache writes use the
 * per-TTL breakdown when present; otherwise they're priced at the 1-hour rate (the higher one)
 * unless `cacheTtl` says which TTL was requested. Rounded up to 4 decimals.
 */
export function costFromUsage(
  usage: LlmUsage,
  opts: { batch?: boolean; cacheTtl?: CacheTtl } = {},
): number {
  const P = OPUS5_PRICES_PER_MTOK;
  const n = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  const writes = n(usage.cache_creation_input_tokens);
  const w5 = n(usage.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  let writeUsd: number;
  if (w5 + w1 > 0) {
    // Any tokens the breakdown doesn't explain are priced at the higher rate.
    writeUsd =
      w5 * P.cacheWrite5m + w1 * P.cacheWrite1h + Math.max(0, writes - w5 - w1) * P.cacheWrite1h;
  } else {
    writeUsd = writes * (opts.cacheTtl === "5m" ? P.cacheWrite5m : P.cacheWrite1h);
  }
  let usd =
    (n(usage.input_tokens) * P.input +
      n(usage.output_tokens) * P.output +
      n(usage.cache_read_input_tokens) * P.cacheRead +
      writeUsd) /
    1e6;
  if (opts.batch) usd *= BATCH_DISCOUNT;
  return ceil4(usd);
}
