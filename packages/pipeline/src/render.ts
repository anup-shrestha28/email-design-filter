/**
 * Render orchestration (FREE-TIER.md §5.1–5.3): one user per batch, a hard wall-clock budget
 * (230 s by default; the step has retries 0), priority on-demand → template samples → fill.
 * For each email: refetch from Gmail (a 404 hard-deletes it), apply the image policy, pre-fetch
 * allowed images with the SSRF-safe fetcher as data: URIs (≤ 60 images, ≤ 5 MB each, ≤ 15 MB per
 * email; every image not inlined is logged with its reason), render, validate the output as untrusted, rescore, store per email. AI tiles stay in
 * memory and are handed to the AI step only (never persisted).
 */
import { withSystem, withUser } from "@edf/db";
import { extractContent, parseMime } from "@edf/core";
import { extractImageRefs, imageFetchDecision, imagesAllowedFor } from "@edf/core/policy";
import type { EmailType } from "@edf/core/types";
import {
  SCORING_VERSION,
  buildDesignFeatures,
  extractStaticDesign,
  fontProfile,
  hierarchyProxies,
  inheritFromTemplate,
  renderFeaturesSchema,
  scoreEmail,
  summarizeScore,
  templateMatch,
  type AiReview,
  type DesignFeatures,
  type RenderJob,
  type RenderJobContext,
  type RenderOutcome,
  type ScoreContext,
} from "@edf/design";
import { fetchImage } from "@edf/fetch";
import {
  FLOOR_BACKGROUND,
  RAW_FIELDS,
  UNITS,
  base64ResponseCap,
  decodeRawMessage,
  isGmailError,
  reserveQuota,
} from "@edf/gmail";
import { designAiStateOf } from "./analyze";
import { gmailClient, logOf, nowOf, type PipelineDeps } from "./deps";
import { reviewRealtime, submitDesignReviewBatch, type DesignReviewItem } from "./ai";
import { reapStaleRenderRequests } from "./maintenance";
import { errorCode } from "./poll";
import { currentRenderOptions, freshCpuUsed } from "./render-plan";
import {
  FILL_WINDOW_DAYS,
  FRESH_CANDIDATE_SQL,
  FRESH_CPU_RESOURCE,
  freshAllowanceLeft,
  RENDER_VM_VCPUS,
} from "./render-policy";
import { saveAnalysis, type DesignColumns } from "./store/email";
import type { AnalysisRecord } from "./store/record";

export const RENDER_STEP_BUDGET_MS = 230_000;
export const MAX_EMAILS_PER_BATCH = 25;
const MAX_IMAGES = 60;
/**
 * Per-image byte limit for the analysis pre-fetch: 5 MB (the SSRF-safe fetcher's ceiling), up from
 * 2 MB, so image-only emails built from one big picture (4–5 MB PNGs) are measured, not blank. The
 * 15 MB per-email budget, the 5 s timeout and the fetcher's 25-megapixel limit stay: a larger
 * picture is logged `too_large` / `too_many_pixels` and the render records it as not drawn. The
 * viewer's image proxy keeps its own limit.
 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const EMAIL_IMAGE_BUDGET = 15 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5_000;
const TEMPLATE_UPGRADE_LIMIT = 50;
const SAMPLE_VALID_DAYS = 60;

type Kind = "on_demand" | "exemplar" | "fill";

interface WorkItem {
  requestId: string;
  emailId: string;
  kind: Kind;
  wantAi: boolean;
  attempts: number;
}

interface EmailRow {
  id: string;
  mailbox_id: string;
  provider_message_id: string;
  provider_account_id: string;
  template_id: string | null;
  template_seen: number | null;
  primary_type: EmailType;
  is_subscription: boolean;
  type_confidence: number | null;
  subject: string | null;
  snippet: string | null;
  received_at: Date;
  security_sensitive: boolean;
  suspicious: boolean;
  language: string | null;
  sender_domain: string | null;
  list_unsubscribe: { https?: string[] } | null;
  load_images: boolean;
  prior_ai: AiReview | null;
}

export interface RenderOptions {
  budgetMs?: number;
  /** Governor/Sandbox actions (FREE-TIER.md §8.3). */
  fillAllowed: boolean;
  samplesAllowed: boolean;
  onDemandOnly?: boolean;
  /**
   * A fresh batch (render-policy.ts): queued on-demand requests, then fill for the user's
   * fresh mail only (static-only, ≤ 48 h, never requested) instead of the nightly 14-day fill; no
   * template samples (they wait for the nightly run, as before).
   */
  fresh?: boolean;
  /** AI batches for samples allowed (seen ≥ 2, budget, not paused). */
  aiSamplesAllowed: boolean;
  /** On-demand "Run AI review" allowed (governor aiOff / AI paused → false). */
  aiRealtimeAllowed?: boolean;
}

export interface RenderSummary {
  picked: number;
  rendered: number;
  failed: number;
  gone: number;
  upgraded: number;
  aiQueued: number;
  skipped: string | null;
}

function scoreContext(row: EmailRow, now: Date): ScoreContext {
  return {
    primaryType: row.primary_type,
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
}

/** Everything the design columns need, from features + score (shared by render and template upgrades). */
export function designColumnsFor(
  features: DesignFeatures,
  ctx: ScoreContext,
  coverage: "render" | "template",
): { analysis: AnalysisRecord; design: DesignColumns; proxies: number[] } {
  const score = scoreEmail(features, ctx);
  const profile = fontProfile(features.fonts, { source: coverage });
  return {
    analysis: {
      scoringVersion: SCORING_VERSION,
      rendererVersion: features.render?.meta.rendererVersion ?? null,
      features,
      checks: score.checks,
      pillarScores: score.pillars,
      rawScore: score.raw,
      caps: score.caps,
      confidence: score.confidence,
      trust: null,
      scoreSummary: summarizeScore(score, profile, features.render ?? null),
      aiReview: features.ai,
      aiModel: features.ai?.model ?? null,
      renderRefEmailId: features.renderRef?.emailId ?? null,
      rendererHost: null,
      chromiumVersion: features.render?.meta.chromium ?? null,
      renderMs: null,
    },
    design: {
      designStatus: "done",
      designSource: coverage,
      designAiState: designAiStateOf(features.ai),
      designScore: score.score,
      designBand: score.band,
      designCapped: score.score === null ? null : score.capped,
      designProvisional: score.score === null ? null : score.provisional,
      designIssues: score.issues,
      designConfidence: score.score === null ? null : score.confidenceBand,
      fontSource: coverage,
      fontFamilies: profile.fontFamilies.slice(0, 12),
      usesWebFonts: profile.usesWebFonts,
    },
    proxies: hierarchyProxies(score),
  };
}

/**
 * Queued request kinds a batch may pick: re-queued fill and samples wait while the governor has them
 * off. A fresh batch takes queued on-demand work only, plus the fill rows it inserts itself: queued
 * fill (a retry, or the rest of a nightly batch) and samples wait for the nightly run, so each email
 * gets one fresh try and every fresh batch that renders fill leaves its own rows (the rate limit's
 * record, render-policy.ts).
 */
export function workKinds(opts: RenderOptions): Kind[] {
  const kinds: Kind[] = ["on_demand"];
  if (!opts.onDemandOnly && !opts.fresh && opts.samplesAllowed) kinds.push("exemplar");
  if (!opts.onDemandOnly && !opts.fresh && opts.fillAllowed) kinds.push("fill");
  return kinds;
}

/**
 * Add a fresh batch's share of its VM time to the fresh allowance (render-policy.ts): render-VM
 * vCPUs × the wall time of the renderBatch call (VM creation to stop, at least what the Sandbox
 * meter counts from the API's timestamps), × fill items / items rendered. Rounded up; a failed
 * write only loses this batch's share here (the Sandbox meter itself still counts the VM).
 */
async function recordFreshCpu(deps: PipelineDeps, fillItems: number, items: number, startedAt: number): Promise<void> {
  if (fillItems <= 0 || items <= 0) return;
  const cpuS = ((RENDER_VM_VCPUS * Math.max(0, Date.now() - startedAt)) / 1000) * (fillItems / items);
  const amount = Math.ceil(cpuS * 1e6) / 1e6;
  if (amount <= 0) return;
  await withSystem(deps.pool, (_db, c) =>
    c.query("SELECT add_usage(current_date, $1, $2::numeric)", [FRESH_CPU_RESOURCE, amount]),
  ).catch((err: unknown) => logOf(deps)("render.fresh_cpu_unrecorded", { code: errorCode(err) }));
}

async function pickWork(
  deps: PipelineDeps,
  userId: string,
  opts: RenderOptions,
): Promise<WorkItem[]> {
  return withUser(deps.pool, userId, async (_db, c) => {
    // Requests a killed step left 'running' go back in the queue (or fail) first.
    await reapStaleRenderRequests(c, userId);
    const kinds = workKinds(opts);
    const queued = await c.query<{
      id: string;
      email_id: string;
      kind: Kind;
      want_ai: boolean;
      attempts: number;
    }>(
      `SELECT id, email_id, kind, want_ai, attempts FROM render_request
       WHERE user_id = $1 AND state = 'queued' AND kind = ANY($2::text[])
       ORDER BY CASE kind WHEN 'on_demand' THEN 0 WHEN 'exemplar' THEN 1 ELSE 2 END, requested_at
       LIMIT $3 FOR UPDATE SKIP LOCKED`,
      [userId, kinds, MAX_EMAILS_PER_BATCH],
    );
    let items = queued.rows.map((r) => ({
      requestId: r.id,
      emailId: r.email_id,
      kind: r.kind,
      wantAi: r.want_ai,
      attempts: r.attempts,
    }));
    if (opts.fillAllowed && !opts.onDemandOnly && items.length < MAX_EMAILS_PER_BATCH) {
      // Nightly: recent designable mail without its own render (static or template coverage), in an
      // active mailbox (loadEmail refuses the others). Fresh: only new mail with no score at all.
      const which = opts.fresh
        ? FRESH_CANDIDATE_SQL
        : `e.received_at > now() - make_interval(days => ${FILL_WINDOW_DAYS}) AND e.design_status = 'done'
           AND e.design_source IN ('static', 'template') AND NOT e.security_sensitive AND NOT e.is_hidden
           AND EXISTS (SELECT 1 FROM mailbox m WHERE m.id = e.mailbox_id AND m.status = 'active')
           AND NOT EXISTS (SELECT 1 FROM render_request r WHERE r.email_id = e.id AND r.state IN ('queued', 'running'))`;
      const fill = await c.query<{ id: string; email_id: string }>(
        `INSERT INTO render_request (user_id, email_id, kind)
         SELECT $1, e.id, 'fill' FROM email e
         WHERE e.user_id = $1 AND ${which}
         ORDER BY e.received_at DESC LIMIT $2
         ON CONFLICT (email_id) WHERE state IN ('queued', 'running') DO NOTHING
         RETURNING id, email_id`,
        [userId, MAX_EMAILS_PER_BATCH - items.length],
      );
      items = items.concat(
        fill.rows.map((r) => ({
          requestId: r.id,
          emailId: r.email_id,
          kind: "fill" as const,
          wantAi: false,
          attempts: 0,
        })),
      );
    }
    if (items.length) {
      await c.query(
        "UPDATE render_request SET state = 'running', attempts = attempts + 1, updated_at = now() WHERE id = ANY($1::uuid[])",
        [items.map((i) => i.requestId)],
      );
    }
    return items;
  });
}

async function loadEmail(
  deps: PipelineDeps,
  userId: string,
  emailId: string,
): Promise<{ row: EmailRow; addresses: string[] } | null> {
  return withUser(deps.pool, userId, async (_db, c) => {
    const r = await c.query<EmailRow>(
      `SELECT e.id, e.mailbox_id, e.provider_message_id, m.provider_account_id, e.template_id, t.seen_count AS template_seen,
              e.primary_type, e.is_subscription, e.type_confidence, e.subject, e.snippet, e.received_at, e.security_sensitive,
              e.suspicious, e.language, s.domain AS sender_domain, s.list_unsubscribe,
              coalesce(us.load_images_for_analysis, true) AS load_images,
              CASE WHEN a.features->'ai'->>'source' = 'email' THEN a.features->'ai' END AS prior_ai
       FROM email e JOIN mailbox m ON m.id = e.mailbox_id
       LEFT JOIN sender s ON s.id = e.sender_id
       LEFT JOIN email_template t ON t.id = e.template_id
       LEFT JOIN user_settings us ON us.user_id = e.user_id
       LEFT JOIN email_analysis a ON a.email_id = e.id
       WHERE e.id = $1 AND m.status = 'active'`,
      [emailId],
    );
    const row = r.rows[0];
    if (!row) return null;
    const addrs = await c.query<{ a: string }>(
      "SELECT lower(email_address::text) AS a FROM mailbox WHERE user_id = $1",
      [userId],
    );
    return { row, addresses: addrs.rows.map((x) => x.a) };
  });
}

async function fetchRaw(
  deps: PipelineDeps,
  userId: string,
  row: EmailRow,
): Promise<Uint8Array | "gone"> {
  const override = deps.rawSourceFor?.({
    userId,
    mailboxId: row.mailbox_id,
    providerAccountId: row.provider_account_id,
  });
  if (override) return (await override(row.provider_message_id)) ?? "gone";
  const q = await withUser(deps.pool, userId, (db) =>
    reserveQuota(db, {
      mailboxId: row.mailbox_id,
      units: UNITS.messagesGet,
      floor: FLOOR_BACKGROUND,
    }),
  );
  if (!q.ok) throw new Error("quota");
  try {
    const msg = await gmailClient(deps, userId, row.mailbox_id).messagesGet(
      row.provider_message_id,
      {
        format: "raw",
        fields: RAW_FIELDS,
        maxBytes: base64ResponseCap(8 * 1024 * 1024),
      },
    );
    return decodeRawMessage(msg);
  } catch (err) {
    if (isGmailError(err, "not_found")) return "gone";
    throw err;
  }
}

/** Signed-URL expiry parameters (epoch seconds, or S3 v4's date + lifetime). */
const EXPIRY_PARAMS = ["e", "exp", "expires", "Expires"] as const;

/**
 * The signed URL's expiry has passed: LinkedIn media links (`e=<epoch>`), CloudFront/S3 v2
 * (`Expires=<epoch>`) and S3 v4 (`X-Amz-Date` + `X-Amz-Expires`). A 401/403/410 on such a URL is an
 * expired link, not a broken image.
 */
export function signedUrlExpired(url: string, now: Date): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const nowSec = now.getTime() / 1000;
  for (const p of EXPIRY_PARAMS) {
    const v = u.searchParams.get(p);
    // 10-digit epochs only (2001–2286): `e=1` style flags aren't expiries.
    if (v && /^\d{10}$/.test(v)) return Number(v) < nowSec;
  }
  const date = u.searchParams.get("X-Amz-Date");
  const life = u.searchParams.get("X-Amz-Expires");
  const m = date ? /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date) : null;
  if (m && life && /^\d{1,7}$/.test(life)) {
    const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) / 1000;
    return t + Number(life) < nowSec;
  }
  return false;
}

type ImageLogEntry = RenderJob["imageLog"][string];

/**
 * The log entry for an image fetch that didn't succeed. Our own byte/pixel limits are
 * "too_large" (not evaluated), never the sender's 200 — a 2xx that didn't decode would otherwise
 * read as a broken, non-image response. An SVG keeps its 200 with `reason: "svg"` (the render
 * reports it as a format Gmail doesn't show, not as broken).
 */
export function failedFetchLog(
  r: { reason: string; status?: number; svg?: boolean },
  url: string,
  now: Date,
): ImageLogEntry {
  if (r.reason === "timeout") return { status: "timeout", bytes: 0, reason: "timeout" };
  if (r.reason === "too_large") return { status: "too_large", bytes: 0, reason: "too_large" };
  if (r.reason === "too_many_pixels")
    return { status: "too_large", bytes: 0, reason: "too_many_pixels" };
  if (typeof r.status === "number") {
    const ok = r.status >= 200 && r.status < 300;
    const reason = ok
      ? r.svg
        ? "svg"
        : "not_image"
      : [401, 403, 410].includes(r.status) && signedUrlExpired(url, now)
        ? "expired"
        : "http";
    return { status: r.status, bytes: 0, reason };
  }
  return { status: "error", bytes: 0, reason: "network" };
}

/**
 * Pre-fetch policy-allowed images as data: URIs, with per-image and per-email byte caps. Every
 * image that isn't inlined is logged with why (`reason`): the policy's refusal (tracker, pixel,
 * per_recipient…), the spent email budget, our limits, the sender's answer or the fetch failure.
 */
export async function prefetchImages(
  html: string,
  ctx: { userAddresses: string[]; imagesAllowed: boolean; now?: Date },
): Promise<Pick<RenderJob, "images" | "imageLog">> {
  const images: Record<string, string> = {};
  const imageLog: RenderJob["imageLog"] = {};
  if (!ctx.imagesAllowed) return { images, imageLog };
  const now = ctx.now ?? new Date();
  const refs = extractImageRefs(html, { max: MAX_IMAGES });
  let budget = EMAIL_IMAGE_BUDGET;
  let i = 0;
  const worker = async () => {
    for (;;) {
      const ref = refs[i++];
      if (!ref) return;
      const decision = imageFetchDecision(ref, {
        userAddresses: ctx.userAddresses,
        imagesAllowed: true,
      });
      if (!decision.allowed) {
        const why = decision.reason;
        imageLog[ref.src] = {
          status: "blocked",
          bytes: 0,
          reason:
            why === "tracker" || why === "pixel" || why === "per_recipient" || why === "not_http"
              ? why
              : "policy",
        };
        continue;
      }
      if (budget <= 0) {
        imageLog[ref.src] = { status: "blocked", bytes: 0, reason: "budget" };
        continue;
      }
      const cap = Math.min(IMAGE_MAX_BYTES, budget);
      const r = await fetchImage(ref.src, { maxBytes: cap, timeoutMs: IMAGE_TIMEOUT_MS }).catch(
        () => null,
      );
      if (!r) {
        imageLog[ref.src] = { status: "error", bytes: 0, reason: "network" };
      } else if (r.ok && r.body.byteLength > budget) {
        // Four fetches run at once, each capped by the budget left when it started: one that
        // finishes after the others spent the budget is dropped, so the inlined images never
        // exceed it (at 5 MB per image, overshooting could have doubled it).
        imageLog[ref.src] = { status: "too_large", bytes: 0, reason: "budget" };
      } else if (r.ok) {
        budget -= r.body.byteLength;
        images[ref.src] = `data:${r.contentType};base64,${r.body.toString("base64")}`;
        imageLog[ref.src] = { status: 200, bytes: r.body.byteLength };
      } else if (r.reason === "too_large" && cap < IMAGE_MAX_BYTES) {
        // Cut off by what was left of the email's budget, not by the per-image limit.
        imageLog[ref.src] = { status: "too_large", bytes: 0, reason: "budget" };
      } else {
        imageLog[ref.src] = failedFetchLog(r, ref.src, now);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { images, imageLog };
}

/** Upgrade same-template emails still at static coverage to template coverage (FREE-TIER.md §5.4). */
async function upgradeTemplate(
  deps: PipelineDeps,
  userId: string,
  templateId: string,
  sample: { emailId: string; features: DesignFeatures },
  now: Date,
): Promise<number> {
  const rows = await withUser(
    deps.pool,
    userId,
    async (_db, c) =>
      (
        await c.query<EmailRow & { features: DesignFeatures | null }>(
          `SELECT e.id, e.primary_type, e.is_subscription, e.type_confidence, e.subject, e.snippet, e.received_at, e.language,
              s.domain AS sender_domain, s.list_unsubscribe, a.features
       FROM email e LEFT JOIN sender s ON s.id = e.sender_id JOIN email_analysis a ON a.email_id = e.id
       WHERE e.template_id = $1 AND e.design_source = 'static' AND e.id <> $2
         AND e.received_at > now() - make_interval(days => $3) AND a.features IS NOT NULL
       ORDER BY e.received_at DESC LIMIT $4`,
          [templateId, sample.emailId, SAMPLE_VALID_DAYS, TEMPLATE_UPGRADE_LIMIT],
        )
      ).rows,
  );
  let upgraded = 0;
  for (const r of rows) {
    if (!r.features || !templateMatch(sample.features, r.features)) continue;
    const inherited = inheritFromTemplate(
      sample.features,
      { static: r.features.static, fonts: r.features.fonts },
      {
        emailId: sample.emailId,
        renderedAt: now.toISOString(),
      },
    );
    const cols = designColumnsFor(inherited, scoreContext(r, now), "template");
    const saved = await withUser(deps.pool, userId, (_db, c) =>
      saveAnalysis(c, { emailId: r.id, userId, ...cols }),
    );
    if (saved) upgraded++;
  }
  return upgraded;
}

/**
 * A request left undone ("deferred": the step's time budget ran out before any work on it) goes
 * back to the queue whatever its kind and gets back the attempt `pickWork` counted, so an
 * on-demand click is never failed for work that never ran (the render run loops while on-demand
 * work remains). One deferred after its Gmail fetch and image pre-fetch ("deferred_after_fetch")
 * also goes back whatever its kind, but keeps the attempt, since quota was spent on it: after 3
 * such attempts it fails instead of re-fetching forever. Other failures re-queue background kinds
 * up to 3 attempts.
 */
async function finishRequest(
  deps: PipelineDeps,
  userId: string,
  item: WorkItem,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await withUser(deps.pool, userId, (_db, c) =>
    c.query(
      `UPDATE render_request SET state = CASE WHEN $2 THEN 'done'
                                              WHEN $3::text = 'deferred' THEN 'queued'
                                              WHEN $3::text = 'deferred_after_fetch' AND attempts < 3 THEN 'queued'
                                              WHEN kind <> 'on_demand' AND attempts < 3 THEN 'queued'
                                              ELSE 'failed' END,
              attempts = CASE WHEN NOT $2 AND $3::text = 'deferred' THEN greatest(attempts - 1, 0) ELSE attempts END,
              error = $3, updated_at = now() WHERE id = $1`,
      [item.requestId, ok, error],
    ),
  );
}

/**
 * Render one user's due work within the step budget (FREE-TIER.md §5.1). Never throws on vendor outages.
 * The governor is re-read first: `opts` came from a plan that may be minutes old, and a Sandbox cap
 * reached since then must still stop this VM (§8.3).
 */
export async function renderForUser(
  deps: PipelineDeps,
  userId: string,
  planned: RenderOptions,
): Promise<RenderSummary> {
  const started = Date.now();
  const deadline = started + (planned.budgetMs ?? RENDER_STEP_BUDGET_MS);
  const now = nowOf(deps);
  const log = logOf(deps);
  const out: RenderSummary = {
    picked: 0,
    rendered: 0,
    failed: 0,
    gone: 0,
    upgraded: 0,
    aiQueued: 0,
    skipped: null,
  };
  if (!deps.renderer) {
    out.skipped = "renderer_unavailable";
    return out;
  }
  let opts = await currentRenderOptions(deps, userId, planned);
  if (!opts) {
    out.skipped = "governor";
    return out;
  }
  // A fresh batch's own Sandbox allowance (render-policy.ts), re-read: the plan can be minutes old.
  // Used up: the VM (if any) takes only the user's queued on-demand requests.
  if (opts.fresh && opts.fillAllowed && !freshAllowanceLeft(await freshCpuUsed(deps))) {
    opts = { ...opts, fillAllowed: false };
  }
  const work = await pickWork(deps, userId, opts);
  out.picked = work.length;
  if (work.length === 0) return out;

  // Prepare jobs while the measured time estimate stays well before the deadline.
  interface Prepared {
    item: WorkItem;
    row: EmailRow;
    job: RenderJob;
    staticFeatures: ReturnType<typeof extractStaticDesign>;
    visibleText: string;
  }
  const prepared: Prepared[] = [];
  const perEmailEstimate = 9_000;
  for (const item of work) {
    if (Date.now() + perEmailEstimate * (prepared.length + 1) > deadline - 30_000) {
      await finishRequest(deps, userId, item, false, "deferred").catch(() => {});
      continue;
    }
    try {
      const loaded = await loadEmail(deps, userId, item.emailId);
      if (!loaded || loaded.row.security_sensitive) {
        await finishRequest(deps, userId, item, false, "not_designable");
        continue;
      }
      const raw = await fetchRaw(deps, userId, loaded.row);
      if (raw === "gone") {
        // Deleted in Gmail: never rendered, shown or sent to AI again (FREE-TIER.md §4.6).
        await withUser(deps.pool, userId, (_db, c) =>
          c.query("DELETE FROM email WHERE id = $1", [item.emailId]),
        );
        out.gone++;
        continue;
      }
      const parsed = await parseMime(raw);
      if (!parsed.html) {
        await finishRequest(deps, userId, item, false, "plain_text");
        continue;
      }
      const imagesAllowed =
        !loaded.row.suspicious &&
        imagesAllowedFor({
          primaryType: loaded.row.primary_type,
          securitySensitive: loaded.row.security_sensitive,
          suspicious: loaded.row.suspicious,
          loadImagesForAnalysis: loaded.row.load_images,
        });
      const { images, imageLog } = await prefetchImages(parsed.html, {
        userAddresses: loaded.addresses,
        imagesAllowed,
        now,
      });
      // Image pre-fetch can take far longer than the per-email estimate: re-check the deadline.
      if (Date.now() + perEmailEstimate * (prepared.length + 1) > deadline - 30_000) {
        await finishRequest(deps, userId, item, false, "deferred_after_fetch").catch(() => {});
        continue;
      }
      const cid: Record<string, string> = {};
      if (imagesAllowed) {
        for (const p of parsed.inline) {
          if (
            /^image\/(png|gif|jpeg|webp)$/.test(p.mimeType) &&
            p.content.byteLength <= 1024 * 1024
          ) {
            cid[p.cid] = `data:${p.mimeType};base64,${Buffer.from(p.content).toString("base64")}`;
          }
        }
      }
      // Footer/unsubscribe markers, the logo token and word segmentation (DESIGN-SCORE §2.1), for both passes.
      const context: RenderJobContext = {
        listUnsubscribeHttps: loaded.row.list_unsubscribe?.https ?? [],
        senderDomain: loaded.row.sender_domain,
        language: loaded.row.language,
      };
      const staticFeatures = extractStaticDesign(parsed.html, {
        htmlBytes: parsed.htmlBytes,
        subject: parsed.subject,
        ...context,
      });
      const content = extractContent(parsed, {
        receivedAt: loaded.row.received_at,
        userAddresses: loaded.addresses,
        fromDomain: loaded.row.sender_domain,
      });
      prepared.push({
        item,
        row: loaded.row,
        staticFeatures,
        visibleText: content.visibleText,
        job: {
          id: item.emailId,
          html: parsed.html,
          images,
          cid,
          imageLog,
          imagesAllowed,
          wantAiTiles: item.wantAi || (item.kind === "exemplar" && opts.aiSamplesAllowed),
          lite: false,
          context,
        },
      });
    } catch (err) {
      out.failed++;
      await finishRequest(deps, userId, item, false, errorCode(err)).catch(() => {});
    }
  }
  if (prepared.length === 0) return out;

  let outcomes: RenderOutcome[];
  const vmStartedAt = Date.now();
  // A fresh batch's VM time counts toward its own allowance (its fill items' share: the same VM
  // may also have taken the user's on-demand requests), as the Sandbox meter counts it.
  const recordFresh = () =>
    opts.fresh ? recordFreshCpu(deps, prepared.filter((p) => p.item.kind === "fill").length, prepared.length, vmStartedAt) : Promise.resolve();
  try {
    outcomes = await deps.renderer.renderBatch(
      prepared.map((p) => p.job),
      { deadlineMs: Math.max(20_000, deadline - Date.now() - 15_000) },
    );
  } catch (err) {
    await recordFresh();
    out.skipped = errorCode(err);
    for (const p of prepared)
      await finishRequest(deps, userId, p.item, false, "renderer_error").catch(() => {});
    return out;
  }
  await recordFresh();
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const aiItems: DesignReviewItem[] = [];

  for (const p of prepared) {
    const outcome = byId.get(p.item.emailId);
    const valid = outcome?.ok ? renderFeaturesSchema.safeParse(outcome.features) : null;
    if (!outcome || !outcome.ok || !valid?.success) {
      out.failed++;
      await finishRequest(
        deps,
        userId,
        p.item,
        false,
        outcome?.error ?? (valid && !valid.success ? "invalid_output" : "no_output"),
      ).catch(() => {});
      continue;
    }
    try {
      let features = buildDesignFeatures({
        static: p.staticFeatures.static,
        fonts: p.staticFeatures.fonts,
        render: valid.data,
        ai: p.row.prior_ai,
      });
      const ctx = scoreContext(p.row, now);
      let cols = designColumnsFor(features, ctx, "render");
      const cta = valid.data.cta.primary?.target ?? null;
      if (p.item.wantAi && outcome.aiTiles && deps.anthropic && opts.aiRealtimeAllowed !== false) {
        const review = await reviewRealtime(deps, {
          userId,
          emailId: p.item.emailId,
          tiles: outcome.aiTiles,
          subject: p.row.subject,
          type: p.row.primary_type,
          ctaBox: cta ? { pass: "mobile", ...cta } : null,
          visibleText: p.visibleText,
          hierarchyProxies: cols.proxies,
        });
        if (review) {
          features = { ...features, ai: review };
          cols = designColumnsFor(features, ctx, "render");
        }
      }
      cols.analysis.rendererHost = deps.renderer.host;
      cols.analysis.renderMs = outcome.renderMs;
      cols.analysis.chromiumVersion = outcome.chromiumVersion;
      await withUser(deps.pool, userId, (_db, c) =>
        saveAnalysis(c, { emailId: p.item.emailId, userId, ...cols, force: true }),
      );
      out.rendered++;
      await finishRequest(deps, userId, p.item, true, null);

      if (p.row.template_id) {
        const tid = p.row.template_id;
        await withUser(deps.pool, userId, (_db, c) =>
          c.query(
            `UPDATE email_template SET exemplar_email_id = $2, exemplar_rendered_at = now()
             WHERE id = $1 AND ($3 OR exemplar_rendered_at IS NULL OR exemplar_rendered_at < now() - interval '1 day')`,
            [tid, p.item.emailId, p.item.kind === "exemplar"],
          ),
        );
        out.upgraded += await upgradeTemplate(
          deps,
          userId,
          tid,
          { emailId: p.item.emailId, features },
          now,
        );
        if (
          p.item.kind === "exemplar" &&
          opts.aiSamplesAllowed &&
          (p.row.template_seen ?? 0) >= 2 &&
          outcome.aiTiles &&
          !features.ai
        ) {
          aiItems.push({
            userId,
            emailId: p.item.emailId,
            templateId: tid,
            input: {
              tiles: outcome.aiTiles,
              subject: p.row.subject,
              type: p.row.primary_type,
              ctaBox: cta ? { pass: "mobile", ...cta } : null,
              visibleText: p.visibleText,
            },
          });
        }
      }
    } catch (err) {
      out.failed++;
      await finishRequest(deps, userId, p.item, false, errorCode(err)).catch(() => {});
    }
  }

  if (aiItems.length && deps.anthropic) {
    const r = await submitDesignReviewBatch(deps, aiItems).catch((err: unknown) => {
      log("ai.batch_submit_failed", { code: errorCode(err) });
      return null;
    });
    out.aiQueued = r?.queued ?? 0;
  }
  log("render.user_done", {
    rendered: out.rendered,
    failed: out.failed,
    upgraded: out.upgraded,
    ai: out.aiQueued,
    ms: Date.now() - started,
  });
  return out;
}
