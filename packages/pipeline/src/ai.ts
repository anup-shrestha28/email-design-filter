/**
 * Claude Opus 5 with a hard spending cap (FREE-TIER.md §6): every call or batch reserves its worst
 * case atomically (`reserve_llm`, priced from the free count_tokens endpoint) and settles from
 * `usage`. Real-time reviews run with retries 0 and a 120 s timeout (Anthropic bills a request even
 * if the client disconnects). Batches commit an `ai_batch` row BEFORE `batches.create` and adopt a
 * crashed submission by created_at + request count (§5.1 step 7). Spend-limit errors pause AI
 * globally and are never retried (§6.5 layer 5). Reviews are never shared between users.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { withSystem, withUser, type PoolClient } from "@edf/db";
import { costFromUsage, llmCaps, priceRequest, renderGovernorOf, type LlmUsage } from "@edf/budget";
import { computeImportance, importanceLevel, parseLlmClassification } from "@edf/core";
import {
  AI_MAX_TOKENS,
  AI_MODEL,
  AI_OUTPUT_CONFIG,
  REVIEW_SYSTEM_PROMPT,
  applyAiGuards,
  buildReviewUserContent,
  parseReviewOutput,
  prescanInjection,
  toAiReview,
  type AiReview,
  type DesignFeatures,
  type ReviewInput,
} from "@edf/design";
import { raiseAlert } from "./alerts";
import { logOf, nowOf, type PipelineDeps } from "./deps";
import { errorCode } from "./poll";

const REALTIME_TIMEOUT_MS = 120_000;
const CORPUS_MEDIAN_LEVEL = 3; // prior until the team corpus exists (DESIGN-SCORE §8)
const CACHE_MIN_BATCH = 3; // 1-hour cache only for batches with ≥ 3 requests (FREE-TIER.md §6.2)

type OutputConfig = NonNullable<Anthropic.MessageCountTokensParams["output_config"]>;

/**
 * Tokens up to and including the cached system prompt, priced as a cache write in the worst case
 * (FREE-TIER.md §6.5). Counted with the request's own `output_config` (a structured-output format
 * adds system text of its own) and a one-character message, so it is never below the billed prefix.
 */
async function countPrefixTokens(client: Anthropic, system: Anthropic.TextBlockParam[], outputConfig: OutputConfig): Promise<number> {
  const r = await client.messages.countTokens({ model: AI_MODEL, system, messages: [{ role: "user", content: "." }], output_config: outputConfig });
  return r.input_tokens;
}

// ───────────────────────── budget & pause ─────────────────────────

interface AiState {
  paused: boolean;
  /**
   * The governor's `aiOff` (the AI self-cap reached, or L3): all AI stops (FREE-TIER.md §6.5
   * layer 4, §8.3). Its value is calibrated spend, so with a calibration factor above 1 it trips
   * before `reserve_llm`'s ledger cap does. Render paths read it through their options.
   */
  governorAiOff: boolean;
  G: number;
}

export async function aiState(deps: PipelineDeps): Promise<AiState> {
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM app_setting WHERE key IN ('ai.paused', 'ai.cap_usd', 'kill.ai', 'governor')",
    );
    const v = new Map(r.rows.map((x) => [x.key, x.value]));
    const paused = Boolean((v.get("ai.paused") as { paused?: boolean } | undefined)?.paused) || v.get("kill.ai") === true;
    const gov = renderGovernorOf(v.get("governor") as Parameters<typeof renderGovernorOf>[0]);
    const G = Number(v.get("ai.cap_usd") ?? 5);
    return { paused, governorAiOff: gov.level >= 3 || gov.actions.aiOff === true, G: Number.isFinite(G) && G >= 0 ? G : 5 };
  });
}

export async function pauseAi(deps: PipelineDeps, reason: string): Promise<void> {
  await withSystem(deps.pool, (_db, c) =>
    c.query("UPDATE app_setting SET value = $1, updated_at = now() WHERE key = 'ai.paused'", [
      JSON.stringify({ paused: true, reason, since: new Date().toISOString() }),
    ]),
  );
  await raiseAlert(deps.pool, deps.alerts ?? { token: undefined, repo: undefined }, "AI_PAUSED", { reason });
}

/** Spend-limit / credit errors: pause AI globally, never retry (FREE-TIER.md §6.5 layer 5). */
export function isSpendLimitError(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: { error?: { details?: { error_code?: string }; message?: string } } };
  const msg = `${e?.message ?? ""} ${e?.error?.error?.message ?? ""}`;
  if (e?.status === 429 && e.error?.error?.details?.error_code === "enforced_spend_limit_reached") return true;
  if (e?.status === 400 && /usage limits/i.test(msg)) return true;
  return /credit balance is too low|insufficient credit/i.test(msg);
}

async function capsFor(c: PoolClient, userId: string, G: number, day: string): Promise<{ globalCap: number; monthCap: number; dayCap: number }> {
  const r = await c.query<{ role: "owner" | "friend"; active: string; friends: string; global: string | null; owner: string | null }>(
    `SELECT us.role,
            (SELECT count(*) FROM list_active_users() u WHERE u.mailboxes > 0) AS active,
            (SELECT count(*) FROM list_active_users() u WHERE u.mailboxes > 0 AND u.role = 'friend') AS friends,
            (SELECT reserved_usd FROM llm_budget_global WHERE period = date_trunc('month', $2::date)::date) AS global,
            llm_owner_month_reserved($2::date) AS owner
     FROM user_settings us WHERE us.user_id = $1`,
    [userId, day],
  );
  const row = r.rows[0];
  return llmCaps({
    G,
    role: row?.role ?? "friend",
    activeUsers: Number(row?.active ?? 1),
    activeFriends: Number(row?.friends ?? 0),
    globalReservedUsd: Number(row?.global ?? 0),
    ownerMonthReservedUsd: Number(row?.owner ?? 0),
  });
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** A batch item, recorded in the same transaction as its reservation (see `reserve`). */
interface BatchItemRecord {
  batchId: string;
  purpose: "design_review" | "classify";
  cid: string;
  emailId: string;
  templateId: string | null;
  /** Design review: the injection pre-scan of subject + visible text hit (read back on collection). */
  injectionHit?: boolean;
}

/**
 * Reserve `usd` for `userId` on today's UTC day. With `record` (a batch item), the `ai_batch` row
 * ('submitting', created by the first item) and the `ai_batch_item` row are written in the same
 * transaction as the reservation, so no reservation ever exists without an item that settles it:
 * a crash or error before `batches.create` leaves items that `collectBatches` releases once no
 * batch matches them (or the daily cron after 24 h) (§5.1 step 7).
 */
async function reserve(
  deps: PipelineDeps,
  userId: string,
  usd: number,
  G: number,
  record?: BatchItemRecord,
): Promise<{ ok: boolean; day: string }> {
  const day = utcDay(nowOf(deps));
  const amount = Math.max(0.0001, Math.round(usd * 10_000) / 10_000);
  const ok = await withUser(deps.pool, userId, async (_db, c) => {
    const caps = await capsFor(c, userId, G, day);
    const r = await c.query<{ ok: boolean }>("SELECT reserve_llm($1, $2, $3::date, $4, $5, $6) AS ok", [
      userId,
      amount,
      day,
      caps.globalCap,
      caps.monthCap,
      caps.dayCap,
    ]);
    const reserved = Boolean(r.rows[0]?.ok);
    if (reserved && record) {
      await c.query(
        `INSERT INTO ai_batch (id, purpose, state, reserved_usd, item_count) VALUES ($1, $2, 'submitting', 0, 0)
         ON CONFLICT (id) DO NOTHING`,
        [record.batchId, record.purpose],
      );
      await c.query(
        `INSERT INTO ai_batch_item (custom_id, batch_id, user_id, email_id, template_id, purpose, reserved_usd, reserved_day, injection_hit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9)`,
        [record.cid, record.batchId, userId, record.emailId, record.templateId, record.purpose, amount, day, record.injectionHit ?? false],
      );
    }
    return reserved;
  });
  return { ok, day };
}

/**
 * Whether `userId` still has room for a request of at least `usd` (read only, nothing reserved).
 * Checked before the costly work of preparing a request (a Gmail fetch, parse, count_tokens), so
 * a user over their cap costs nothing per tick; `reserve` remains the authoritative check.
 */
async function hasRoom(deps: PipelineDeps, userId: string, usd: number, G: number): Promise<boolean> {
  const day = utcDay(nowOf(deps));
  return withUser(deps.pool, userId, async (_db, c) => {
    const caps = await capsFor(c, userId, G, day);
    const r = await c.query<{ month: string | null; day: string | null; global: string | null }>(
      `SELECT (SELECT reserved_usd FROM llm_budget WHERE user_id = $1 AND scope = 'month' AND day = date_trunc('month', $2::date)::date) AS month,
              (SELECT reserved_usd FROM llm_budget WHERE user_id = $1 AND scope = 'day' AND day = $2::date) AS day,
              (SELECT reserved_usd FROM llm_budget_global WHERE period = date_trunc('month', $2::date)::date) AS global`,
      [userId, day],
    );
    const row = r.rows[0];
    return (
      Number(row?.global ?? 0) + usd <= caps.globalCap &&
      Number(row?.month ?? 0) + usd <= caps.monthCap &&
      Number(row?.day ?? 0) + usd <= caps.dayCap
    );
  });
}

/**
 * Settle a reservation made on `day` and meter its usage. With `customId` (a batch item), the item is
 * marked settled in the same transaction, only if it wasn't already (`settled_usd IS NULL`), and its
 * stored reservation and reservation day are settled — so an item is settled at most once, against
 * the day it was reserved, even when collection is retried. Returns false if it was already settled.
 * `apply` (the item's result) runs in that same transaction, so a crash before the commit leaves the
 * item unsettled and unapplied for the retry; an error in `apply` is logged and rolled back alone.
 * `apply` runs before `settle_llm`, which locks the month's `llm_budget_global` row: that lock is
 * then held only to the commit, not while the result is saved, so it doesn't stall other users.
 */
async function settle(
  deps: PipelineDeps,
  p: {
    userId: string; reserved: number; actual: number; day: string; purpose: "classify" | "design_review"; batch: boolean;
    usage: LlmUsage | null; customId?: string; apply?: (c: PoolClient) => Promise<void>;
  },
): Promise<boolean> {
  const actual = Math.min(10, Math.round(p.actual * 10_000) / 10_000);
  const settled = await withUser(deps.pool, p.userId, async (_db, c) => {
    let reserved = Math.round(p.reserved * 10_000) / 10_000;
    let reservedDay = p.day;
    if (p.customId !== undefined) {
      const r = await c.query<{ reserved_usd: string; reserved_day: string }>(
        "UPDATE ai_batch_item SET settled_usd = $2 WHERE custom_id = $1 AND settled_usd IS NULL RETURNING reserved_usd, reserved_day::text",
        [p.customId, actual],
      );
      const item = r.rows[0];
      if (!item) return false;
      reserved = Number(item.reserved_usd);
      reservedDay = item.reserved_day;
    }
    if (p.apply) {
      await c.query("SAVEPOINT apply");
      try {
        await p.apply(c);
        await c.query("RELEASE SAVEPOINT apply");
      } catch (err) {
        await c.query("ROLLBACK TO SAVEPOINT apply");
        logOf(deps)("ai.apply_failed", { code: errorCode(err) });
      }
    }
    if (p.usage) {
      await c.query(
        `INSERT INTO llm_usage (user_id, day, purpose, model, batch, requests, input_tokens, cached_input_tokens, output_tokens, cost_usd)
         VALUES ($1, $2::date, $3, $4, $5, 1, $6, $7, $8, $9)
         ON CONFLICT (user_id, day, purpose, model, batch) DO UPDATE SET
           requests = llm_usage.requests + 1, input_tokens = llm_usage.input_tokens + EXCLUDED.input_tokens,
           cached_input_tokens = llm_usage.cached_input_tokens + EXCLUDED.cached_input_tokens,
           output_tokens = llm_usage.output_tokens + EXCLUDED.output_tokens, cost_usd = llm_usage.cost_usd + EXCLUDED.cost_usd`,
        [
          p.userId, p.day, p.purpose, AI_MODEL, p.batch, p.usage.input_tokens,
          p.usage.cache_read_input_tokens ?? 0, p.usage.output_tokens, p.actual,
        ],
      );
    }
    await c.query("SELECT settle_llm($1, $2, $3, $4::date)", [p.userId, reserved, actual, reservedDay]);
    return true;
  });
  if (!settled) return false;
  await withSystem(deps.pool, (_db, c) => c.query("SELECT add_usage(current_date, 'anthropic.usd', $1)", [p.actual])).catch(() => {});
  return true;
}

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ───────────────────────── real-time review (on demand) ─────────────────────────

export interface RealtimeReviewInput extends ReviewInput {
  userId: string;
  emailId: string;
  hierarchyProxies: number[];
}

/** "Run AI review" on one email (FREE-TIER.md §6.1): real time, retries 0, reserved first. */
export async function reviewRealtime(deps: PipelineDeps, input: RealtimeReviewInput): Promise<AiReview | null> {
  const client = deps.anthropic;
  if (!client) return null;
  const st = await aiState(deps);
  if (st.paused) return null;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildReviewUserContent(input) }];
  let previousInconsistent = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    // With the output_config the call sends: its format's system text is billed input too (§6.5).
    const count = await client.messages.countTokens({ model: AI_MODEL, system: REVIEW_SYSTEM_PROMPT, messages, output_config: AI_OUTPUT_CONFIG });
    const worst = priceRequest({ inputTokens: count.input_tokens, maxTokens: AI_MAX_TOKENS, batch: false });
    const res = await reserve(deps, input.userId, worst, st.G);
    if (!res.ok) {
      logOf(deps)("ai.budget_refused", { purpose: "design_review" });
      return null;
    }
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create(
        { model: AI_MODEL, max_tokens: AI_MAX_TOKENS, system: REVIEW_SYSTEM_PROMPT, messages, output_config: AI_OUTPUT_CONFIG },
        { timeout: REALTIME_TIMEOUT_MS, maxRetries: 0 },
      );
    } catch (err) {
      if (isSpendLimitError(err)) {
        await settle(deps, { userId: input.userId, reserved: worst, actual: 0, day: res.day, purpose: "design_review", batch: false, usage: null });
        await pauseAi(deps, "spend_limit");
        return null;
      }
      const status = (err as { status?: number }).status;
      // A rejected request (4xx) is not billed; a timeout or 5xx may be — keep the worst case reserved.
      const actual = typeof status === "number" && status >= 400 && status < 500 ? 0 : worst;
      await settle(deps, { userId: input.userId, reserved: worst, actual, day: res.day, purpose: "design_review", batch: false, usage: null });
      logOf(deps)("ai.realtime_error", { code: errorCode(err) });
      return null;
    }
    const usage = msg.usage as unknown as LlmUsage;
    await settle(deps, { userId: input.userId, reserved: worst, actual: costFromUsage(usage), day: res.day, purpose: "design_review", batch: false, usage });
    const refused = msg.stop_reason === "refusal";
    const review = toAiReview(refused ? null : parseReviewOutput(safeJson(textOf(msg))), {
      reviewedAt: new Date().toISOString(),
      source: "email",
      injectionPatternHit: prescanInjection(`${input.subject ?? ""}\n${input.visibleText}`),
      refused,
    });
    const guarded = applyAiGuards(review, {
      corpusMedianLevel: CORPUS_MEDIAN_LEVEL,
      hierarchyProxies: input.hierarchyProxies,
      previousAttemptInconsistent: previousInconsistent,
    });
    if (guarded.crossCheck === "rerun" && attempt === 0) {
      previousInconsistent = true;
      continue;
    }
    return guarded.review;
  }
  return null;
}

// ───────────────────────── Message Batches (template samples) ─────────────────────────

export interface DesignReviewItem {
  userId: string;
  emailId: string;
  templateId: string;
  input: ReviewInput;
}

function customId(prefix: "dr" | "cl", emailId: string, batchId: string): string {
  return `${prefix}_${emailId.replaceAll("-", "")}_${batchId.replaceAll("-", "").slice(-10)}`;
}

/** Submit a design-review batch for template samples; tiles stay in memory (FREE-TIER.md §5.1 step 7). */
export async function submitDesignReviewBatch(deps: PipelineDeps, items: DesignReviewItem[]): Promise<{ queued: number } | null> {
  const client = deps.anthropic;
  if (!client || items.length === 0) return null;
  const st = await aiState(deps);
  if (st.paused) return null;
  const cache = items.length >= CACHE_MIN_BATCH;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: REVIEW_SYSTEM_PROMPT, ...(cache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}) },
  ];
  const batchId = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ id: string }>("SELECT uuidv7() AS id")).rows[0]!.id,
  );
  const accepted: Array<{ item: DesignReviewItem; params: Anthropic.MessageCreateParamsNonStreaming; worst: number; day: string; cid: string }> = [];
  try {
    const systemTokens = cache ? await countPrefixTokens(client, system, AI_OUTPUT_CONFIG) : 0;
    for (const item of items) {
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: buildReviewUserContent(item.input) }];
      const count = await client.messages.countTokens({ model: AI_MODEL, system, messages, output_config: AI_OUTPUT_CONFIG });
      const worst = priceRequest({
        inputTokens: count.input_tokens,
        cachedPrefixTokens: cache ? Math.min(systemTokens, count.input_tokens) : 0,
        cacheTtl: cache ? "1h" : null,
        maxTokens: AI_MAX_TOKENS,
        batch: true,
      });
      const cid = customId("dr", item.emailId, batchId);
      // Pre-scanned now, as a real-time review is (subject + visible text, DESIGN-SCORE §6): the
      // visible text isn't stored, so collection reads the result from the item.
      const injectionHit = prescanInjection(`${item.input.subject ?? ""}\n${item.input.visibleText}`);
      const r = await reserve(deps, item.userId, worst, st.G, {
        batchId, purpose: "design_review", cid, emailId: item.emailId, templateId: item.templateId, injectionHit,
      });
      if (!r.ok) continue;
      accepted.push({
        item,
        worst,
        day: r.day,
        cid,
        params: { model: AI_MODEL, max_tokens: AI_MAX_TOKENS, system, messages, output_config: AI_OUTPUT_CONFIG },
      });
    }
  } catch (err) {
    // Nothing was sent (e.g. count_tokens failed for a later item): release what was reserved.
    if (accepted.length) await releaseBatch(deps, batchId);
    throw err;
  }
  if (accepted.length === 0) return { queued: 0 };
  return submitBatch(
    deps,
    batchId,
    "design_review",
    accepted.map((a) => ({ ...a, templateId: a.item.templateId, userId: a.item.userId, emailId: a.item.emailId, recorded: true })),
  );
}

/**
 * Whether a failed `batches.create` certainly created no batch: a 4xx rejection (other than a 408
 * timeout). A timeout, a dropped connection or a 5xx may come after Anthropic accepted the batch,
 * which then runs and is billed.
 */
function isDefiniteRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/**
 * Release every unsettled item of a batch that was never sent (settled at 0, once each), then mark
 * the batch 'failed' if it is still 'submitting'. Returns the number of items released. Used when
 * `batches.create` is definitely rejected, when preparing a batch fails, and by the daily cron for
 * batches stuck in 'submitting' for more than 24 h (FREE-TIER.md §5.1 step 7).
 */
export async function releaseBatch(deps: PipelineDeps, batchId: string): Promise<number> {
  const items = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ custom_id: string; user_id: string; purpose: string; reserved_usd: string; reserved_day: string; settled_usd: string | null }>(
      "SELECT custom_id, user_id, purpose, reserved_usd, reserved_day::text AS reserved_day, settled_usd FROM list_batch_items($1)",
      [batchId],
    )).rows,
  );
  let released = 0;
  for (const i of items) {
    if (i.settled_usd !== null) continue;
    const purpose = i.purpose === "classify" ? "classify" : "design_review";
    if (await settle(deps, { userId: i.user_id, reserved: Number(i.reserved_usd), actual: 0, day: i.reserved_day, purpose, batch: true, usage: null, customId: i.custom_id })) {
      released++;
    }
  }
  await withSystem(deps.pool, (_db, c) =>
    c.query("UPDATE ai_batch SET state = 'failed', ended_at = now() WHERE id = $1 AND state = 'submitting'", [batchId]),
  );
  return released;
}

async function submitBatch(
  deps: PipelineDeps,
  batchId: string,
  purpose: "design_review" | "classify",
  items: Array<{
    cid: string; userId: string; emailId: string; templateId: string | null; worst: number; day: string;
    params: Anthropic.MessageCreateParamsNonStreaming;
    /** Already written with its reservation (`reserve` with a record); otherwise written here. */
    recorded?: boolean;
  }>,
): Promise<{ queued: number }> {
  const client = deps.anthropic!;
  const total = items.reduce((s, i) => s + i.worst, 0);
  // 1. Commit the 'submitting' row and the items BEFORE creating the batch. created_at is reset
  //    here, just before `batches.create`, because adoption matches batches created after it.
  await withSystem(deps.pool, (_db, c) =>
    c.query(
      `INSERT INTO ai_batch (id, purpose, state, reserved_usd, item_count) VALUES ($1, $2, 'submitting', $3, $4)
       ON CONFLICT (id) DO UPDATE SET reserved_usd = EXCLUDED.reserved_usd, item_count = EXCLUDED.item_count, created_at = now()
       WHERE ai_batch.state = 'submitting'`,
      [batchId, purpose, Math.round(total * 10_000) / 10_000, items.length],
    ),
  );
  for (const i of items) {
    if (i.recorded) continue;
    await withUser(deps.pool, i.userId, (_db, c) =>
      c.query(
        `INSERT INTO ai_batch_item (custom_id, batch_id, user_id, email_id, template_id, purpose, reserved_usd, reserved_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date)`,
        [i.cid, batchId, i.userId, i.emailId, i.templateId, purpose, Math.round(i.worst * 10_000) / 10_000, i.day],
      ),
    );
  }
  // 2. Create the batch; 3. store its id. Never create a second batch for this row.
  try {
    const batch = await client.messages.batches.create({ requests: items.map((i) => ({ custom_id: i.cid, params: i.params })) });
    await withSystem(deps.pool, (_db, c) =>
      c.query("UPDATE ai_batch SET anthropic_batch_id = $2, state = 'submitted', submitted_at = now() WHERE id = $1", [batchId, batch.id]),
    );
    return { queued: items.length };
  } catch (err) {
    const spend = isSpendLimitError(err);
    if (!spend && !isDefiniteRejection(err)) {
      // The batch may exist and be billed: keep the row 'submitting' and the reservations held.
      // The tick adopts it by created_at + request count; if it hasn't appeared 30 minutes later,
      // the tick releases the reservations (the daily cron after 24 h, if listing keeps failing)
      // (FREE-TIER.md §5.1 step 7).
      logOf(deps)("ai.batch_create_uncertain", { code: errorCode(err) });
      throw err;
    }
    await releaseBatch(deps, batchId);
    if (spend) await pauseAi(deps, "spend_limit");
    throw err;
  }
}

// ───────────────────────── collecting results (tick "ai" step) ─────────────────────────

export interface CollectSummary {
  adopted: number;
  ended: number;
  applied: number;
  released: number;
}

/**
 * A 'submitting' row unmatched this long after its created_at (the 10-minute adoption window plus a
 * margin for clock skew and a slow `batches.create`) has no batch at Anthropic, if the listing
 * reaches back before the row.
 */
const ADOPT_GIVE_UP_MS = 30 * 60_000;

/**
 * How far Anthropic's clock may run behind the database's: a batch whose created_at is up to this
 * much before its row's still matches it (the request count and, when results arrive, each
 * custom_id confirm the match).
 */
const ADOPT_CLOCK_SKEW_MS = 5 * 60_000;

/** Listing pages read per tick to reach back to the oldest 'submitting' row (20 batches each). */
const ADOPT_LIST_MAX_PAGES = 5;

type BatchListing = { data: Anthropic.Messages.MessageBatch[]; has_more?: boolean };

/** Whether a newest-first `batches.list` listing holds every batch created at or after `since`. */
function pageCovers(page: { data: Array<{ created_at: string }>; has_more?: boolean }, since: Date): boolean {
  return page.has_more !== true || page.data.some((b) => Date.parse(b.created_at) < since.getTime());
}

/**
 * Newest-first batches back to `since` (the oldest 'submitting' row, less the clock skew), a page
 * at a time, so a row with more than 20 newer batches is still matched or released on the tick
 * rather than waiting for the daily cron's 24 h release.
 */
async function listBatchesSince(client: Anthropic, since: Date): Promise<BatchListing> {
  const out: BatchListing = { data: [], has_more: false };
  let afterId: string | undefined;
  for (let i = 0; i < ADOPT_LIST_MAX_PAGES; i++) {
    const page = (await client.messages.batches.list({ limit: 20, ...(afterId ? { after_id: afterId } : {}) })) as unknown as BatchListing;
    out.data.push(...page.data);
    out.has_more = page.has_more === true;
    afterId = page.data.at(-1)?.id;
    if (!afterId || pageCovers(page, since)) break;
  }
  return out;
}

/** Adopt crashed submissions, collect ended batches, apply results, settle per item. */
export async function collectBatches(deps: PipelineDeps): Promise<CollectSummary> {
  const client = deps.anthropic;
  const out: CollectSummary = { adopted: 0, ended: 0, applied: 0, released: 0 };
  if (!client) return out;
  const open = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ id: string; anthropic_batch_id: string | null; state: string; item_count: number; created_at: Date }>(
      "SELECT id, anthropic_batch_id, state, item_count, created_at FROM ai_batch WHERE state IN ('submitting', 'submitted') ORDER BY created_at LIMIT 20",
    )).rows,
  );
  if (open.length === 0) return out;

  // Adopt 'submitting' rows by created_at (≤ 10 min after the row) and request count (§5.1 step 7).
  const submitting = open.filter((b) => b.state === "submitting");
  if (submitting.length) {
    const oldest = Math.min(...submitting.map((b) => b.created_at.getTime()));
    const page = await listBatchesSince(client, new Date(oldest - ADOPT_CLOCK_SKEW_MS));
    // Exclude every listed batch any row already owns — open or finished — so a skewed window
    // never picks another row's batch (anthropic_batch_id is UNIQUE; adopting it would throw).
    const listedIds = page.data.map((b) => b.id);
    const owned = listedIds.length
      ? await withSystem(deps.pool, async (_db, c) =>
          (await c.query<{ anthropic_batch_id: string }>(
            "SELECT anthropic_batch_id FROM ai_batch WHERE anthropic_batch_id = ANY($1::text[])",
            [listedIds],
          )).rows.map((r) => r.anthropic_batch_id),
        )
      : [];
    const known = new Set<string>([...open.map((b) => b.anthropic_batch_id).filter((id): id is string => !!id), ...owned]);
    for (const row of submitting) {
      const candidate = page.data.find((b) => {
        if (known.has(b.id)) return false;
        const t = Date.parse(b.created_at);
        const total = b.request_counts.processing + b.request_counts.succeeded + b.request_counts.errored + b.request_counts.canceled + b.request_counts.expired;
        return t >= row.created_at.getTime() - ADOPT_CLOCK_SKEW_MS && t <= row.created_at.getTime() + 10 * 60_000 && total === row.item_count;
      });
      if (candidate) {
        known.add(candidate.id);
        await withSystem(deps.pool, (_db, c) =>
          c.query("UPDATE ai_batch SET anthropic_batch_id = $2, state = 'submitted', submitted_at = now() WHERE id = $1", [row.id, candidate.id]),
        );
        row.anthropic_batch_id = candidate.id;
        row.state = "submitted";
        out.adopted++;
      } else if (
        Date.now() - row.created_at.getTime() >= ADOPT_GIVE_UP_MS &&
        pageCovers(page, new Date(row.created_at.getTime() - ADOPT_CLOCK_SKEW_MS))
      ) {
        // Past the adoption window and the listing reaches back before the row: no batch was
        // created for it (a lost response after a 5xx/529 or a killed step). Release it now rather
        // than holding the reservations for the daily cron's 24 h.
        out.released += await releaseBatch(deps, row.id);
        row.state = "failed";
      }
    }
  }

  for (const row of open) {
    if (row.state !== "submitted" || !row.anthropic_batch_id) continue;
    const b = await client.messages.batches.retrieve(row.anthropic_batch_id);
    if (b.processing_status !== "ended") continue;
    const decoder = await client.messages.batches.results(row.anthropic_batch_id);
    for await (const res of decoder) {
      const item = await withSystem(deps.pool, async (_db, c) =>
        (await c.query<{ batch_id: string; user_id: string; email_id: string | null; template_id: string | null; purpose: string; reserved_usd: string; settled_usd: string | null }>(
          "SELECT batch_id, user_id, email_id, template_id, purpose, reserved_usd, settled_usd FROM lookup_batch_item($1)",
          [res.custom_id],
        )).rows[0],
      );
      if (!item || item.batch_id !== row.id) continue; // confirm the adopted batch by custom_id
      if (item.settled_usd !== null) continue; // done by an earlier, interrupted collection
      const reserved = Number(item.reserved_usd);
      const day = utcDay(nowOf(deps)); // metering day; the budget is settled against the reservation day
      const purpose = item.purpose === "classify" ? "classify" : "design_review";
      if (res.result.type === "succeeded") {
        const msg = res.result.message;
        const usage = msg.usage as unknown as LlmUsage;
        const actual = costFromUsage(usage, { batch: true, cacheTtl: "1h" });
        let applied = false;
        // The email may have been deleted meanwhile (email_id NULL): the request is still billed
        // and settled, but there is nothing to apply the result to.
        const emailId = item.email_id;
        await settle(deps, {
          userId: item.user_id, reserved, actual, day, purpose, batch: true, usage, customId: res.custom_id,
          apply: emailId === null ? undefined : async (c) => {
            const target = { ...item, email_id: emailId, custom_id: res.custom_id };
            if (item.purpose === "design_review") await applyDesignReview(deps, c, target, msg);
            else await applyClassification(deps, c, target, msg);
            applied = true;
          },
        });
        if (applied) out.applied++;
      } else {
        // errored / canceled / expired requests are not billed: release the reservation.
        if (await settle(deps, { userId: item.user_id, reserved, actual: 0, day, purpose, batch: true, usage: null, customId: res.custom_id })) {
          out.released++;
        }
      }
    }
    await withSystem(deps.pool, (_db, c) =>
      c.query(
        `UPDATE ai_batch SET state = 'ended', ended_at = now(),
                settled_usd = (SELECT coalesce(sum(i.settled_usd), 0) FROM list_batch_items($1) i) WHERE id = $1`,
        [row.id],
      ),
    );
    out.ended++;
  }
  return out;
}

/** Runs in the item's settle transaction (`c`, tenant = item.user_id). */
async function applyDesignReview(
  deps: PipelineDeps,
  c: PoolClient,
  item: { user_id: string; email_id: string; template_id: string | null; custom_id: string },
  msg: Anthropic.Message,
): Promise<void> {
  const { designColumnsFor } = await import("./render");
  const refused = msg.stop_reason === "refusal";
  const r = await c.query<{
    features: DesignFeatures | null;
    subject: string | null;
    snippet: string | null;
    primary_type: string;
    is_subscription: boolean;
    type_confidence: number | null;
    received_at: Date;
    language: string | null;
    sender_domain: string | null;
    list_unsubscribe: { https?: string[] } | null;
  }>(
    `SELECT a.features, e.subject, e.snippet, e.primary_type, e.is_subscription, e.type_confidence, e.received_at, e.language,
            s.domain AS sender_domain, s.list_unsubscribe
     FROM email e JOIN email_analysis a ON a.email_id = e.id LEFT JOIN sender s ON s.id = e.sender_id WHERE e.id = $1`,
    [item.email_id],
  );
  const row = r.rows[0];
  if (!row?.features?.render) return;
  // The submit-time pre-scan (subject + visible text); the subject is re-scanned for items
  // submitted before it was kept (0014).
  const scanned = await c.query<{ injection_hit: boolean }>("SELECT injection_hit FROM ai_batch_item WHERE custom_id = $1", [item.custom_id]);
  const review = toAiReview(refused ? null : parseReviewOutput(safeJson(textOf(msg))), {
    reviewedAt: new Date().toISOString(),
    source: "email",
    injectionPatternHit: Boolean(scanned.rows[0]?.injection_hit) || prescanInjection(row.subject ?? ""),
    refused,
  });
  const now = nowOf(deps);
  const ctx = {
    primaryType: row.primary_type as ReviewInput["type"],
    isSubscription: row.is_subscription,
    typeConfidence: row.type_confidence,
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    now,
    listUnsubscribeHttps: row.list_unsubscribe?.https ?? [],
    senderDomain: row.sender_domain,
    language: row.language,
  };
  const base = designColumnsFor(row.features, ctx, "render");
  const guarded = applyAiGuards(review, { corpusMedianLevel: CORPUS_MEDIAN_LEVEL, hierarchyProxies: base.proxies });
  const features: DesignFeatures = { ...row.features, ai: guarded.review };
  const cols = designColumnsFor(features, ctx, "render");
  const { saveAnalysis } = await import("./store/email");
  await saveAnalysis(c, { emailId: item.email_id, userId: item.user_id, ...cols, force: true });
  if (item.template_id) {
    // Template-level criteria for later emails of this template (counts 0.5 in confidence there).
    await c.query(
      `UPDATE email_template SET ai_review = $2, ai_model = $3, ai_reviewed_at = now(), ai_source_email_id = $4 WHERE id = $1`,
      [item.template_id, JSON.stringify({ ...guarded.review, source: "template" }), AI_MODEL, item.email_id],
    );
  }
}

/** Runs in the item's settle transaction (`c`, tenant = item.user_id). */
async function applyClassification(
  deps: PipelineDeps,
  c: PoolClient,
  item: { user_id: string; email_id: string; template_id: string | null },
  msg: Anthropic.Message,
): Promise<void> {
  const cls = msg.stop_reason === "refusal" ? null : parseLlmClassification(safeJson(textOf(msg)));
  if (!cls) {
    // No usable answer: keep the rule cascade's type (never re-submitted, never a paid retry loop).
    await c.query("UPDATE email SET type_source = 'rule' WHERE id = $1 AND type_source = 'pending'", [item.email_id]);
    return;
  }
  const r = await c.query<{
    type_source: string;
    security_sensitive: boolean;
    suspicious: boolean;
    auth_result: "pass" | "fail" | "none" | "unknown";
    label_ids: string[];
    received_at: Date;
    deal_ends_at: Date | null;
    read_rate_60d: number | null;
    emails_per_week: number | null;
    user_importance_bias: number | null;
  }>(
    `SELECT e.type_source, e.security_sensitive, e.suspicious, e.auth_result, e.label_ids, e.received_at, e.deal_ends_at,
            s.read_rate_60d, s.emails_per_week, s.user_importance_bias
     FROM email e LEFT JOIN sender s ON s.id = e.sender_id WHERE e.id = $1`,
    [item.email_id],
  );
  const e = r.rows[0];
  if (!e || e.type_source === "user") return; // never override the user's correction
  const imp = computeImportance({
    primaryType: cls.primaryType,
    subtype: cls.subtype,
    typeSource: "llm",
    securitySensitive: e.security_sensitive,
    suspicious: e.suspicious,
    authResult: e.auth_result,
    labelIds: e.label_ids,
    receivedAt: e.received_at,
    now: nowOf(deps),
    deals: e.deal_ends_at ? [{ endsAt: e.deal_ends_at }] : [],
    deadlineAt: null,
    prior: e.read_rate_60d === null && e.emails_per_week === null ? null : {
      readRate60d: e.read_rate_60d,
      emailsPerWeek: e.emails_per_week,
      userImportanceBias: e.user_importance_bias ?? 0,
    },
  });
  await c.query(
    `UPDATE email SET primary_type = $2, subtype = $3, type_source = 'llm', type_confidence = $4, is_subscription = $5,
            importance = $6, importance_score = $7, importance_reasons = $8, importance_expires_at = $9, updated_at = now()
     WHERE id = $1 AND type_source <> 'user'`,
    [item.email_id, cls.primaryType, cls.subtype, cls.confidence, cls.isSubscription, importanceLevel(imp.score), imp.score, imp.reasons, imp.expiresAt],
  );
  if (item.template_id) {
    await c.query(
      `UPDATE email_template SET classification = $2, classified_by = $3, classified_at = now() WHERE id = $1`,
      [item.template_id, JSON.stringify({ primaryType: cls.primaryType, subtype: cls.subtype }), AI_MODEL],
    );
  }
}

// ───────────────────────── classification batch (tick) ─────────────────────────

const CLASSIFY_BATCH_MAX = 100;
const CLASSIFY_CACHE_MIN = 10; // cache the system prompt only in batches of ≥ 10 (FREE-TIER.md §6.2)
/**
 * Time for re-fetching and preparing the batch, counted from the start of the tick's "ai" step
 * (`startedAt`), which collects batches first.
 */
const CLASSIFY_PREP_BUDGET_MS = 120_000;

/**
 * Classify mail the rules couldn't settle (type_source = 'pending', older than 20 minutes) in one
 * Message Batch. Content isn't stored, so each message is re-fetched (20 units) and re-extracted in
 * memory. Security-sensitive and non-automated mail is never sent. An email is submitted at most
 * once: after any attempt it keeps its rule-based type if Claude doesn't answer.
 *
 * The queue takes users in turns and only active mailboxes (`list_pending_classification`). A user
 * with no AI budget left is skipped before any Gmail fetch (their rows wait for the next day or
 * month), and mail that can never be sent keeps its rule-based type ('rule'), so neither blocks
 * the queue.
 */
export async function submitClassificationBatch(
  deps: PipelineDeps,
  /** `startedAt`: when the caller's step began (the budget counts from there; default now). */
  opts: { budgetMs?: number; startedAt?: number } = {},
): Promise<{ queued: number } | null> {
  const client = deps.anthropic;
  if (!client) return null;
  const st = await aiState(deps);
  // At the governor's AI cap nothing new is sent; open batches are still collected (collectBatches).
  // "Automatic reviews off" (autoAiOff, 80%) stops design reviews only: classification keeps
  // running (FREE-TIER.md §6.4–6.5).
  if (st.paused || st.governorAiOff) return null;
  const core = await import("@edf/core");
  const gmail = await import("@edf/gmail");
  const { prepareMessage } = await import("./analyze");
  const { gmailClient } = await import("./deps");

  const deadline = (opts.startedAt ?? Date.now()) + (opts.budgetMs ?? CLASSIFY_PREP_BUDGET_MS);
  const pending = await withSystem(deps.pool, async (_db, c) =>
    (await c.query<{ email_id: string; user_id: string; mailbox_id: string; created_at: Date }>(
      "SELECT * FROM list_pending_classification($1)",
      [CLASSIFY_BATCH_MAX],
    )).rows,
  );
  if (pending.length === 0) return { queued: 0 };
  const batchId = await withSystem(deps.pool, async (_db, c) => (await c.query<{ id: string }>("SELECT uuidv7() AS id")).rows[0]!.id);
  const cache = pending.length >= CLASSIFY_CACHE_MIN;
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: core.LLM_CLASSIFY_SYSTEM_PROMPT, ...(cache ? { cache_control: { type: "ephemeral" as const, ttl: "1h" as const } } : {}) },
  ];
  const outputConfig = { effort: "low" as const, format: { type: "json_schema" as const, schema: core.llmClassificationJsonSchema } };
  let prefixTokens: number | undefined; // the cached prefix, counted once (on the first item that gets that far)
  const items: Parameters<typeof submitBatch>[3] = [];
  // The least a classification can cost (its output alone): a user without that much room is skipped.
  const cheapest = priceRequest({ inputTokens: 0, maxTokens: core.LLM_CLASSIFY_MAX_TOKENS, batch: true });
  const noBudget = new Set<string>(); // users refused this run
  const roomChecked = new Set<string>();
  const noQuota = new Set<string>(); // mailboxes out of Gmail quota this run
  // Mail that can never be sent keeps its rule-based type, so it leaves the queue.
  const keepRuleType = (userId: string, emailId: string) =>
    withUser(deps.pool, userId, (_db, c) =>
      c.query("UPDATE email SET type_source = 'rule' WHERE id = $1 AND type_source = 'pending'", [emailId]),
    );

  for (const p of pending) {
    if (Date.now() > deadline) break;
    if (noBudget.has(p.user_id) || noQuota.has(p.mailbox_id)) continue;
    try {
      const row = await withUser(deps.pool, p.user_id, async (_db, c) => {
        const r = await c.query<{
          provider_message_id: string; provider_thread_id: string | null; provider_account_id: string; label_ids: string[];
          snippet: string | null; gmail_history_id: string; received_at: Date; size_bytes: number | null; template_id: string | null;
          security_sensitive: boolean; attempted: boolean;
        }>(
          `SELECT e.provider_message_id, e.provider_thread_id, m.provider_account_id, e.label_ids, e.snippet,
                  e.gmail_history_id::text AS gmail_history_id, e.received_at, e.size_bytes, e.template_id, e.security_sensitive,
                  EXISTS (SELECT 1 FROM ai_batch_item i WHERE i.email_id = e.id AND i.purpose = 'classify') AS attempted
           FROM email e JOIN mailbox m ON m.id = e.mailbox_id WHERE e.id = $1 AND e.type_source = 'pending' AND m.status = 'active'`,
          [p.email_id],
        );
        const addrs = await c.query<{ a: string }>("SELECT lower(email_address::text) AS a FROM mailbox WHERE user_id = $1", [p.user_id]);
        return r.rows[0] ? { ...r.rows[0], addresses: addrs.rows.map((x) => x.a) } : null;
      });
      if (!row) continue;
      if (row.attempted || row.security_sensitive) {
        await keepRuleType(p.user_id, p.email_id);
        continue;
      }
      if (!roomChecked.has(p.user_id)) {
        roomChecked.add(p.user_id);
        if (!(await hasRoom(deps, p.user_id, cheapest, st.G))) {
          noBudget.add(p.user_id);
          continue;
        }
      }
      // Re-fetch (fixture override in development, else Gmail with quota).
      const override = deps.rawSourceFor?.({ userId: p.user_id, mailboxId: p.mailbox_id, providerAccountId: row.provider_account_id });
      let raw: Uint8Array | null;
      if (override) raw = await override(row.provider_message_id);
      else {
        const q = await withUser(deps.pool, p.user_id, (db) => gmail.reserveQuota(db, { mailboxId: p.mailbox_id, units: gmail.UNITS.messagesGet, floor: gmail.FLOOR_BACKGROUND }));
        if (!q.ok) {
          noQuota.add(p.mailbox_id);
          continue;
        }
        try {
          const msg = await gmailClient(deps, p.user_id, p.mailbox_id).messagesGet(row.provider_message_id, {
            format: "raw", fields: gmail.RAW_FIELDS, maxBytes: gmail.base64ResponseCap(gmail.DEFAULT_RAW_MAX_BYTES),
          });
          raw = gmail.decodeRawMessage(msg);
        } catch (err) {
          if (gmail.isGmailError(err, "not_found")) raw = null;
          else throw err;
        }
      }
      if (!raw) {
        await withUser(deps.pool, p.user_id, (_db, c) => c.query("DELETE FROM email WHERE id = $1", [p.email_id]));
        continue;
      }
      // Parsing and preparing are local and deterministic: a message they reject (skipped, security-
      // sensitive, not eligible — LlmEligibilityError) or fail on would fail the same way on every
      // tick, so it keeps its rule-based type instead of being fetched from Gmail again each time.
      const bytes = raw;
      const userContent = await (async () => {
        const parsed = await core.parseMime(bytes);
        const meta = {
          id: row.provider_message_id, threadId: row.provider_thread_id, labelIds: row.label_ids, snippet: row.snippet,
          historyId: row.gmail_history_id, internalDate: row.received_at, sizeEstimate: row.size_bytes,
        };
        const prep = prepareMessage(parsed, meta, row.addresses);
        if (prep.kind === "skip") return null;
        const { headers, content } = prep.prepared;
        const security = core.detectSecuritySensitive({ parsed, content, headers });
        if (security.securitySensitive) return null;
        const provisional = core.classifyType({ parsed, headers, content, labelIds: row.label_ids, security, prior: null, templateClassification: null });
        return core.buildClassifyUserContent({ parsed, headers, content, labelIds: row.label_ids, security, provisional });
      })().catch((err: unknown) => {
        logOf(deps)("ai.classify_prepare_failed", { code: errorCode(err) });
        return null;
      });
      if (userContent === null) {
        await keepRuleType(p.user_id, p.email_id);
        continue;
      }
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: userContent }];
      const count = await client.messages.countTokens({ model: AI_MODEL, system, messages, output_config: outputConfig });
      prefixTokens ??= cache ? await countPrefixTokens(client, system, outputConfig) : 0;
      const worst = priceRequest({
        inputTokens: count.input_tokens,
        cachedPrefixTokens: cache ? Math.min(prefixTokens, count.input_tokens) : 0,
        cacheTtl: cache ? "1h" : null,
        maxTokens: core.LLM_CLASSIFY_MAX_TOKENS,
        batch: true,
      });
      const cid = customId("cl", p.email_id, batchId);
      const res = await reserve(deps, p.user_id, worst, st.G, { batchId, purpose: "classify", cid, emailId: p.email_id, templateId: row.template_id });
      if (!res.ok) {
        noBudget.add(p.user_id);
        continue;
      }
      items.push({
        cid,
        userId: p.user_id,
        emailId: p.email_id,
        templateId: row.template_id,
        worst,
        day: res.day,
        params: { model: AI_MODEL, max_tokens: core.LLM_CLASSIFY_MAX_TOKENS, system, messages, output_config: outputConfig },
        recorded: true,
      });
    } catch (err) {
      logOf(deps)("ai.classify_prepare_failed", { code: errorCode(err) });
    }
  }
  if (items.length === 0) return { queued: 0 };
  return submitBatch(deps, batchId, "classify", items);
}

export { customId as batchCustomId, submitBatch };
