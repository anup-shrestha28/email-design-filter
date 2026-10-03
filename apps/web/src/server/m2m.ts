/**
 * Machine-to-machine authentication for edf-app's endpoints called by edf-view and edf-keys
 * (FREE-TIER.md §9.2, §9.3): a Vercel function OIDC token with pinned iss / aud / sub and
 * exp − iat = 7200 (build tokens rejected). Locally, a development issuer's JWKS is used instead.
 * Failures are recorded as rate-limited, content-free audit rows (endpoint, reason, hashed IP,
 * count per 10 minutes). These endpoints are reachable without any auth and left out of the WAF
 * rate limit (FREE-TIER.md §8.4), so a failure never wakes Neon: the rows are buffered in memory
 * and written only while the database is awake anyway (`databaseAwake()`), when an authenticated
 * machine caller is about to use it, or by the daily cron.
 */
import "server-only";
import { createHmac } from "node:crypto";
import { createOidcVerifier, DEV_OIDC_AUDIENCE, DEV_OIDC_ISSUER } from "@edf/crypto";
import { withSystem } from "@edf/db";
import { env, IS_PROD } from "@/env";
import { getPool } from "./db";
import { databaseAwake, withoutMarkingDbUse } from "./metering";

export type Caller = "edf-view" | "edf-keys";
export type Endpoint = "view-source" | "view-stats" | "keys-audit" | "cron-daily";

type Verifier = (token: string) => Promise<{ sub: string } | null>;
const verifiers = new Map<string, Verifier>();

function verifierFor(endpoint: Exclude<Endpoint, "cron-daily">): Verifier {
  const hit = verifiers.get(endpoint);
  if (hit) return hit;
  const e = env();
  const caller: Caller = endpoint === "keys-audit" ? "edf-keys" : "edf-view";
  let v: Verifier;
  if (e.OIDC_ISSUER) {
    const audience = endpoint === "view-source" ? e.VIEW_SOURCE_AUD : endpoint === "view-stats" ? e.VIEW_STATS_AUD : e.KEYS_AUDIT_AUD;
    const subject = caller === "edf-view" ? e.VIEW_OIDC_SUB : e.KEYS_OIDC_SUB;
    if (!audience || !subject) throw new Error(`OIDC expectations for ${endpoint} are not configured`);
    v = createOidcVerifier({ issuer: e.OIDC_ISSUER, audience, subject });
  } else {
    if (IS_PROD) throw new Error("OIDC_ISSUER is required in production");
    const jwks = process.env.DEV_OIDC_JWKS;
    if (!jwks) {
      v = async () => null; // no dev issuer configured: machine callers are refused
    } else {
      const issuer = process.env.DEV_OIDC_ISSUER ?? DEV_OIDC_ISSUER;
      const subject = caller === "edf-view" ? (process.env.DEV_VIEW_SUB ?? "dev:edf-view") : (process.env.DEV_KEYS_SUB ?? "dev:edf-keys");
      const audience = process.env.DEV_OIDC_AUD ?? DEV_OIDC_AUDIENCE;
      v = createOidcVerifier({ issuer, audience, subject }, { jwks: JSON.parse(jwks) as unknown });
    }
  }
  verifiers.set(endpoint, v);
  return v;
}

// ── failure audit, rate-limited per (endpoint, reason) per 10 minutes ──
interface FailureWindow {
  endpoint: Endpoint;
  reason: string;
  /** Failures in this window so far (reported by the next window's row). */
  count: number;
  firstAt: number;
  ipHash: string | null;
  /** Failures before this window that no written row has reported yet. */
  previous: number;
  /** This window's row is written (or being written). */
  recorded: boolean;
  /**
   * Earlier failures handed over by a failed write after this window's row was already written
   * (or being written): the next window's row reports them.
   */
  carried: number;
}
const failures = new Map<string, FailureWindow>();
const WINDOW_MS = 10 * 60 * 1000;

function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const key = env().VIEW_KEYS ?? "dev-ip-hash-key";
  return createHmac("sha256", key).update(ip).digest("hex").slice(0, 16);
}

/**
 * Count a failure: one row per (endpoint, reason) per 10-minute window, whose
 * `previousWindowCount` reports the failures since the last written row. Written now only if the
 * database is already awake; otherwise it waits in memory (lost only if the instance is reaped
 * first), so anonymous requests can't wake Neon or keep it awake.
 */
export async function recordM2mFailure(endpoint: Endpoint, reason: string, ip: string | null): Promise<void> {
  const k = `${endpoint}:${reason}`;
  const now = Date.now();
  const cur = failures.get(k);
  if (cur && now - cur.firstAt < WINDOW_MS) {
    cur.count++;
  } else {
    // A window whose row was never written folds its count into the next row.
    const previous = cur ? (cur.recorded ? cur.count : cur.previous + cur.count) + cur.carried : 0;
    failures.set(k, { endpoint, reason, count: 1, firstAt: now, ipHash: hashIp(ip), previous, recorded: false, carried: 0 });
  }
  if (databaseAwake()) await flushM2mFailures();
}

/**
 * Write the buffered failure rows. Only for callers already using the database (the database is
 * awake, an authenticated caller's route is about to query it, the daily cron): it opens a
 * connection whenever rows are pending. Never throws.
 */
export async function flushM2mFailures(): Promise<void> {
  const due = [...failures.values()].filter((w) => !w.recorded);
  if (due.length === 0) return;
  for (const w of due) w.recorded = true;
  try {
    await withoutMarkingDbUse(async () => {
      const pool = await getPool();
      await withSystem(pool, async (_db, c) => {
        for (const w of due) {
          await c.query(
            `INSERT INTO audit_log (actor, action, target, ip_hash, metadata) VALUES ('system', 'm2m.auth_failed', $1, $2, $3)`,
            [w.endpoint, w.ipHash, JSON.stringify({ reason: w.reason, previousWindowCount: w.previous })],
          );
        }
      });
    });
  } catch {
    // Never let audit logging turn a 401 into a 500; the rows are tried again next time.
    for (const w of due) {
      const cur = failures.get(`${w.endpoint}:${w.reason}`);
      if (cur === w) w.recorded = false;
      // The window rolled over during the write and the new one took this row as written
      // (reporting only this window's count): hand it the earlier failures this row carried. If
      // the new window's row is already written (or being written), the row after it reports them.
      else if (cur?.recorded) cur.carried += w.previous;
      else if (cur) cur.previous += w.previous;
    }
  }
}

export function clientIp(req: Request): string | null {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
}

/** Verify the caller; returns null (and records the failure) when not authorized. */
export async function authenticateCaller(req: Request, endpoint: Exclude<Endpoint, "cron-daily">): Promise<{ sub: string } | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_\-.]{20,4096})$/.exec(header);
  if (!m?.[1]) {
    await recordM2mFailure(endpoint, "missing_token", clientIp(req));
    return null;
  }
  const ok = await verifierFor(endpoint)(m[1]);
  if (!ok) await recordM2mFailure(endpoint, "invalid_token", clientIp(req));
  else await flushM2mFailures(); // the caller's route is about to use the database anyway
  return ok;
}

export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status, headers: JSON_HEADERS });
}
