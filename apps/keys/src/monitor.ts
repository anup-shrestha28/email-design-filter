/**
 * Stateless-service controls for edf-keys (FREE-TIER.md §9.2, §8.5): per-instance counters.
 *
 * - A 10-minute sliding window (per-minute buckets) of unwraps/generates and refusals drives an
 *   in-process rate limit and the `KEYS_UNWRAP_ANOMALY` GitHub issue (opened, or commented on if
 *   already open, with its own `KEYS_ALERT_TOKEN`; at most once per 30 min per instance).
 * - Counts since the last report are POSTed to edf-app `/api/keys-audit` at most once a minute,
 *   piggy-backed on requests (no timers keep the function alive), authenticated with edf-keys'
 *   own Vercel function token.
 * Everything sent is content-free: codes, counts and time windows only.
 *
 * `/api/keys-audit` wire contract (edf-app answers 204):
 *   { "v": 1, "windowStart": <unix s>, "windowEnd": <unix s>, "counts": { "<code>": <int> } }
 * codes match /^[a-z0-9_]{1,40}$/ (generate_ok, unwrap_ok, rewrapped, refused_<reason>), values
 * 0..10,000,000 (excess carries over to the next report). Two flags are added with value 1:
 * `alert_unconfigured` on every report while the GitHub alert channel is off in production, and
 * `window_clamped` when older unsent counts are reported under a window cut to 24 h, because edf-app
 * rejects windowEnd - windowStart > 86,400 s.
 */
import { randomBytes } from "node:crypto";
import type { KeysConfig } from "./config.js";

export const WINDOW_MS = 10 * 60 * 1000;
const BUCKET_MS = 60 * 1000;
/** Expected load is ~20 refreshes/hour; these are generous per-instance ceilings. */
export const OPS_ALERT_THRESHOLD = 60;
export const REFUSAL_ALERT_THRESHOLD = 20;
export const OPS_HARD_LIMIT = 120;
export const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
export const AUDIT_INTERVAL_MS = 60 * 1000;
export const ANOMALY_CODE = "KEYS_UNWRAP_ANOMALY";
export const ALERT_UNCONFIGURED = "alert_unconfigured";
/** edf-app `/api/keys-audit` rejects longer report windows. */
export const MAX_REPORT_WINDOW_MS = 86_400 * 1000;

export type RefusalCode =
  | "method"
  | "not_found"
  | "unauthorized"
  | "too_large"
  | "unsupported_media_type"
  | "bad_request"
  | "unknown_kek"
  | "unwrap_failed"
  | "rate_limited"
  | "misconfigured";

export type OpCode = "generate_ok" | "unwrap_ok" | "rewrapped";

/** Audit code for each refusal (JSON error codes stay short and stable for callers). */
export const REFUSAL_STAT: Readonly<Record<RefusalCode, string>> = {
  method: "refused_method",
  not_found: "refused_path",
  unauthorized: "refused_oidc",
  too_large: "refused_too_large",
  unsupported_media_type: "refused_media_type",
  bad_request: "refused_body",
  unknown_kek: "refused_version",
  unwrap_failed: "refused_unwrap",
  rate_limited: "refused_rate_limited",
  misconfigured: "refused_misconfigured",
};
export const STAT_MAX_VALUE = 10_000_000;

type Counts = Record<string, number>;

class SlidingWindow {
  #buckets = new Map<number, Counts>();

  add(now: number, key: string): void {
    const b = Math.floor(now / BUCKET_MS);
    const bucket = this.#buckets.get(b) ?? {};
    bucket[key] = (bucket[key] ?? 0) + 1;
    this.#buckets.set(b, bucket);
    this.#prune(now);
  }

  totals(now: number): Counts {
    this.#prune(now);
    const out: Counts = {};
    for (const bucket of this.#buckets.values()) {
      for (const [k, v] of Object.entries(bucket)) out[k] = (out[k] ?? 0) + v;
    }
    return out;
  }

  #prune(now: number): void {
    const oldest = Math.floor((now - WINDOW_MS) / BUCKET_MS);
    for (const b of this.#buckets.keys()) if (b <= oldest) this.#buckets.delete(b);
  }
}

const sum = (c: Counts, keys: readonly string[]): number =>
  keys.reduce((n, k) => n + (c[k] ?? 0), 0);
const OPS: readonly OpCode[] = ["generate_ok", "unwrap_ok"];

export class Monitor {
  readonly instance = randomBytes(6).toString("hex");
  readonly #window = new SlidingWindow();
  #pending: Counts = {};
  #pendingSince: number;
  #lastAudit: number;
  #lastAlert = Number.NEGATIVE_INFINITY;
  #flushing = false;

  constructor(now: number) {
    this.#pendingSince = now;
    this.#lastAudit = now;
  }

  #count(now: number, key: string): void {
    this.#window.add(now, key);
    this.#pending[key] = (this.#pending[key] ?? 0) + 1;
  }

  op(now: number, code: OpCode): void {
    this.#count(now, code);
  }

  refusal(now: number, code: RefusalCode): void {
    this.#count(now, REFUSAL_STAT[code]);
  }

  /** True once this instance has served OPS_HARD_LIMIT operations in the last 10 minutes. */
  overLimit(now: number): boolean {
    return sum(this.#window.totals(now), OPS) >= OPS_HARD_LIMIT;
  }

  /**
   * Post-request housekeeping: raise the anomaly issue and/or report counts when due. Returns a
   * promise the caller hands to `waitUntil` (or awaits); it never rejects.
   */
  housekeeping(cfg: KeysConfig, request: Request): Promise<void> {
    const now = cfg.now();
    const tasks: Promise<void>[] = [];
    const totals = this.#window.totals(now);
    const ops = sum(totals, OPS);
    const refusals = Object.entries(totals).reduce(
      (n, [k, v]) => (k.startsWith("refused_") ? n + v : n),
      0,
    );
    if (
      (ops >= OPS_ALERT_THRESHOLD || refusals >= REFUSAL_ALERT_THRESHOLD) &&
      now - this.#lastAlert >= ALERT_COOLDOWN_MS
    ) {
      this.#lastAlert = now;
      tasks.push(raiseAnomaly(cfg, { instance: this.instance, now, totals, ops, refusals }));
    }
    if (
      now - this.#lastAudit >= AUDIT_INTERVAL_MS &&
      Object.keys(this.#pending).length > 0 &&
      !this.#flushing
    ) {
      const counts: Counts = {};
      const carry: Counts = {};
      for (const [k, v] of Object.entries(this.#pending)) {
        counts[k] = Math.min(v, STAT_MAX_VALUE);
        if (v > STAT_MAX_VALUE) carry[k] = v - STAT_MAX_VALUE;
      }
      const windowStart = Math.max(this.#pendingSince, now - MAX_REPORT_WINDOW_MS);
      const flags: Counts = {};
      if (windowStart > this.#pendingSince) flags.window_clamped = 1;
      if (cfg.alertWarning !== null) flags[ALERT_UNCONFIGURED] = 1;
      this.#pending = carry;
      this.#pendingSince = now;
      this.#lastAudit = now;
      this.#flushing = true;
      tasks.push(
        reportCounts(cfg, request, { windowStart, windowEnd: now, counts: { ...counts, ...flags } })
          .then((ok) => {
            if (!ok) {
              // Keep the counts for the next attempt.
              for (const [k, v] of Object.entries(counts))
                this.#pending[k] = (this.#pending[k] ?? 0) + v;
              this.#pendingSince = Math.min(this.#pendingSince, windowStart);
            }
          })
          .finally(() => {
            this.#flushing = false;
          }),
      );
    }
    return Promise.all(tasks).then(() => undefined);
  }
}

function auditPayload(p: { windowStart: number; windowEnd: number; counts: Counts }): string {
  return JSON.stringify({
    v: 1,
    windowStart: Math.floor(p.windowStart / 1000),
    windowEnd: Math.floor(p.windowEnd / 1000),
    counts: p.counts,
  });
}

async function reportCounts(
  cfg: KeysConfig,
  request: Request,
  p: { windowStart: number; windowEnd: number; counts: Counts },
): Promise<boolean> {
  try {
    const token = await cfg.auditToken(request);
    if (token === null) {
      cfg.log({ ev: "audit_skipped", code: "no_oidc_token" });
      return false;
    }
    const res = await cfg.fetchImpl(cfg.auditUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: auditPayload(p),
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) {
      cfg.log({ ev: "audit_failed", status: res.status });
      return false;
    }
    return true;
  } catch {
    cfg.log({ ev: "audit_failed", code: "network" });
    return false;
  }
}

function issueBody(p: {
  instance: string;
  now: number;
  totals: Counts;
  ops: number;
  refusals: number;
}): string {
  const lines = [
    `Code: ${ANOMALY_CODE}`,
    `Source: edf-keys (instance ${p.instance})`,
    `Window: 10 minutes ending ${new Date(p.now).toISOString()}`,
    `Unwrap + generate: ${p.ops} (alert threshold ${OPS_ALERT_THRESHOLD}, hard limit ${OPS_HARD_LIMIT})`,
    `Refusals: ${p.refusals} (alert threshold ${REFUSAL_ALERT_THRESHOLD})`,
  ];
  for (const [k, v] of Object.entries(p.totals).sort()) lines.push(`- ${k}: ${v}`);
  lines.push(
    "",
    "Counts only; no identifiers. Runbook: FREE-TIER.md §9.2 (rotate KEK / Attack Mode if unexpected).",
  );
  return lines.join("\n");
}

async function raiseAnomaly(
  cfg: KeysConfig,
  p: { instance: string; now: number; totals: Counts; ops: number; refusals: number },
): Promise<void> {
  cfg.log({ ev: "anomaly", ops: p.ops, refusals: p.refusals });
  if (cfg.alert === null) return;
  const api = `https://api.github.com/repos/${cfg.alert.repo}`;
  const headers = {
    authorization: `Bearer ${cfg.alert.token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "edf-keys",
    "content-type": "application/json",
  };
  const call = (url: string, init: RequestInit) =>
    cfg.fetchImpl(url, { ...init, headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  try {
    const list = await call(`${api}/issues?state=open&per_page=100`, { method: "GET" });
    let number: number | null = null;
    if (list.status === 200) {
      const issues = (await list.json()) as Array<{
        number?: unknown;
        title?: unknown;
        pull_request?: unknown;
      }>;
      const found = Array.isArray(issues)
        ? issues.find((i) => i.title === ANOMALY_CODE && i.pull_request === undefined)
        : undefined;
      if (found && typeof found.number === "number") number = found.number;
    } else {
      await list.body?.cancel().catch(() => undefined);
    }
    const body = issueBody(p);
    const res =
      number === null
        ? await call(`${api}/issues`, {
            method: "POST",
            body: JSON.stringify({ title: ANOMALY_CODE, body }),
          })
        : await call(`${api}/issues/${number}/comments`, {
            method: "POST",
            body: JSON.stringify({ body }),
          });
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) cfg.log({ ev: "alert_failed", status: res.status });
  } catch {
    cfg.log({ ev: "alert_failed", code: "network" });
  }
}
