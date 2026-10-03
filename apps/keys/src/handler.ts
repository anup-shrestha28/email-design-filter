/**
 * edf-keys `POST /unwrap` (FREE-TIER.md §9.2). Order of checks (cheapest and most restrictive
 * first; the body of an unauthenticated request is never read):
 *   method → path → declared size → OIDC bearer (edf-app production function) → per-instance
 *   rate limit → content type → size-capped body → strict JSON schema → operation.
 *
 * Ops: `{op:"generate", mailboxId}` → `{dek, wrapped, kekVersion}`;
 *      `{op:"unwrap", mailboxId, wrapped, kekVersion}` → `{dek, rewrapped}` (base64; `rewrapped`
 *      is `{wrapped, kekVersion}` when the DEK was wrapped with a non-active KEK, else null).
 * Responses are JSON with `Cache-Control: no-store`. Logs carry codes and a truncated SHA-256 of
 * the mailbox id at most — never keys, tokens or identifiers in clear.
 */
import { createHash, randomBytes } from "node:crypto";
import { DEK_LENGTH, WRAPPED_DEK_LENGTH, unwrapDek, wrapDek } from "./aead.js";
import { defaultLog, type ConfigResult, type KeysConfig } from "./config.js";
import { ALERT_UNCONFIGURED, Monitor, type RefusalCode } from "./monitor.js";

export const MAX_BODY_BYTES = 4096;
const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEK_VERSION_RE = /^keys:([A-Za-z0-9_-]{1,32})$/;
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type WaitUntil = (p: Promise<unknown>) => void;
export type KeysHandler = (request: Request, waitUntil?: WaitUntil) => Promise<Response>;

const RESPONSE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...RESPONSE_HEADERS, ...extra } });
}

/** Truncated hash for correlating log lines without revealing the mailbox id. */
export function mailboxHash(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex").slice(0, 12);
}

async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function decodeWrapped(v: unknown): Buffer | null {
  if (typeof v !== "string" || !B64_RE.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return buf.length === WRAPPED_DEK_LENGTH && buf.toString("base64") === v ? buf : null;
}

type Body =
  | { op: "generate"; mailboxId: string }
  | { op: "unwrap"; mailboxId: string; wrapped: Buffer; kekVersion: string; kid: string };

function parseBody(bytes: Uint8Array): Body | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (typeof o.mailboxId !== "string" || !MAILBOX_ID_RE.test(o.mailboxId)) return null;
  if (o.op === "generate" && keys === "mailboxId,op")
    return { op: "generate", mailboxId: o.mailboxId };
  if (o.op === "unwrap" && keys === "kekVersion,mailboxId,op,wrapped") {
    const wrapped = decodeWrapped(o.wrapped);
    const m = typeof o.kekVersion === "string" ? KEK_VERSION_RE.exec(o.kekVersion) : null;
    if (wrapped === null || m === null) return null;
    return {
      op: "unwrap",
      mailboxId: o.mailboxId,
      wrapped,
      kekVersion: o.kekVersion as string,
      kid: m[1] as string,
    };
  }
  return null;
}

async function processRequest(
  cfg: KeysConfig,
  monitor: Monitor,
  request: Request,
): Promise<Response> {
  const now = cfg.now();
  const refuse = (
    status: number,
    code: RefusalCode,
    extra: Record<string, string> = {},
    log: Record<string, string> = {},
  ) => {
    monitor.refusal(now, code);
    cfg.log({ ev: "refused", code, ...log });
    return json(status, { error: code }, extra);
  };

  if (request.method !== "POST") return refuse(405, "method", { allow: "POST" });
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return refuse(404, "not_found");
  }
  // Only the public path: vercel.json rewrites `/unwrap` to the function and Vercel hands it the
  // original request path (as edf-view's routes rely on), so a direct `/api/unwrap` call, which
  // the edge rate-limit rule would not see under a path condition, is refused here too
  // (FREE-TIER.md §8.4: the firewall also denies `/api/*` and rate-limits every path). If that
  // premise broke, every unwrap would 404: SETUP.md step 9 checks it on each preview deploy.
  if (path !== "/unwrap") return refuse(404, "not_found");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return refuse(413, "too_large");
  }
  const bearer = BEARER_RE.exec(request.headers.get("authorization") ?? "");
  if (bearer === null || (await cfg.verify(bearer[1] as string)) === null)
    return refuse(401, "unauthorized");
  if (monitor.overLimit(now)) return refuse(429, "rate_limited", { "retry-after": "60" });
  const type = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "unsupported_media_type");
  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (bytes === null) return refuse(413, "too_large");
  const body = parseBody(bytes);
  if (body === null) return refuse(400, "bad_request");

  const activeKek = cfg.keks.get(cfg.activeKid) as Buffer;
  const activeVersion = `keys:${cfg.activeKid}`;

  if (body.op === "generate") {
    const dek = randomBytes(DEK_LENGTH);
    const wrapped = wrapDek(activeKek, dek, body.mailboxId, activeVersion);
    const res = json(200, {
      dek: dek.toString("base64"),
      wrapped: wrapped.toString("base64"),
      kekVersion: activeVersion,
    });
    dek.fill(0);
    monitor.op(now, "generate_ok");
    return res;
  }

  const kek = cfg.keks.get(body.kid);
  if (kek === undefined)
    return refuse(400, "unknown_kek", {}, { mbx: mailboxHash(body.mailboxId) });
  const dek = unwrapDek(kek, body.wrapped, body.mailboxId, body.kekVersion);
  if (dek === null) return refuse(400, "unwrap_failed", {}, { mbx: mailboxHash(body.mailboxId) });
  let rewrapped: { wrapped: string; kekVersion: string } | null = null;
  if (body.kid !== cfg.activeKid) {
    rewrapped = {
      wrapped: wrapDek(activeKek, dek, body.mailboxId, activeVersion).toString("base64"),
      kekVersion: activeVersion,
    };
    monitor.op(now, "rewrapped");
  }
  const res = json(200, { dek: dek.toString("base64"), rewrapped });
  dek.fill(0);
  monitor.op(now, "unwrap_ok");
  return res;
}

/** Build the request handler. Misconfiguration yields 503 on every request (fail closed). */
export function createKeysHandler(
  result: ConfigResult,
  fallbackLog: (e: Record<string, string | number>) => void = defaultLog,
): KeysHandler {
  const monitor = new Monitor(result.ok ? result.config.now() : Date.now());
  // Once per instance (the handler is built at module load): alerting is off, requests still work.
  if (result.ok && result.config.alertWarning !== null)
    result.config.log({
      ev: "warning",
      code: ALERT_UNCONFIGURED,
      reason: result.config.alertWarning,
      fix: "set KEYS_ALERT_TOKEN and GITHUB_ALERT_REPO (FREE-TIER.md §11 step 8)",
    });
  let reportedMisconfig = false;
  return async (request, waitUntil) => {
    if (!result.ok) {
      if (!reportedMisconfig) {
        reportedMisconfig = true;
        fallbackLog({ ev: "misconfigured", code: result.code });
      }
      return json(503, { error: "misconfigured" });
    }
    const cfg = result.config;
    let response: Response;
    try {
      response = await processRequest(cfg, monitor, request);
    } catch {
      cfg.log({ ev: "error", code: "internal" });
      response = json(500, { error: "internal" });
    }
    const background = monitor.housekeeping(cfg, request);
    if (waitUntil) waitUntil(background);
    else await background;
    return response;
  };
}

/** Vercel's `waitUntil` from the request context, when the runtime provides it. */
export function contextWaitUntil(): WaitUntil | undefined {
  const ctx = (globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] as
    { get?: () => { waitUntil?: WaitUntil } | undefined } | undefined;
  const fn = ctx?.get?.()?.waitUntil;
  return typeof fn === "function" ? fn : undefined;
}
