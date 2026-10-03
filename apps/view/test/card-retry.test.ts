/**
 * Gallery cards that fail transiently retry themselves (app.ts "Card retries"): a loading skeleton
 * with an HTTP `Refresh` header back to the same signed path (`?r=<n>`), a few times with growing
 * delays, only for `card` tokens, only for transient upstream failures, and never past the token.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseKeyring, signViewToken, type ViewMode } from "../../../packages/crypto/src/index";
import {
  CARD_RETRY_DELAYS_SEC,
  CARD_RETRY_MIN_TOKEN_SEC,
  TRANSIENT_UPSTREAM_ERRORS,
  cardRetryAttempt,
  createViewApp,
} from "../src/app";
import { loadViewConfig } from "../src/config";
import { viewCsp } from "../src/http";

const APP = "https://edf-app.example";
const VIEW = "https://edf-view.example";
const EMAIL = "0192f0c4-7a1b-7c3d-9e8f-001122334455";
const OIDC = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWV3In0.c2ln";
const viewRing = parseKeyring(JSON.stringify({ v1: randomBytes(32).toString("base64") }));
const cfg = loadViewConfig({
  IMG_PUBKEYS: JSON.stringify({ v1: "MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=" }),
  APP_ORIGIN: APP,
  VIEW_ORIGIN: VIEW,
});
if (!cfg.ok) throw new Error(cfg.code);
const CONFIG = cfg.config;
const ERROR_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": viewCsp(CONFIG),
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (mode: ViewMode = "card", exp = nowSec() + 240) =>
  signViewToken(viewRing, { userId: "u1", emailId: EMAIL, exp, mode });

function makeApp(appResponse: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const app = createViewApp({
    config: CONFIG,
    token: async () => OIDC,
    fetchApp: (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/api/view-stats")) return new Response(null, { status: 204 });
      return appResponse();
    }) as unknown as typeof fetch,
    fetchImage: async () => ({ ok: false, reason: "network" }),
    now: Date.now,
    log: () => undefined,
    sleep: () => new Promise<void>(() => undefined),
  });
  const view = (path: string) =>
    app.view(new Request(`${VIEW}${path}`), () => undefined);
  return { app, calls, view };
}

const rateLimited = () => Response.json({ error: "gmail_rate_limited" }, { status: 503 });

/** The retry's `Refresh` header, split into its delay and path. */
function refreshOf(res: Response): { delay: number; path: string } | null {
  const v = res.headers.get("refresh");
  if (v === null) return null;
  const m = /^(\d+); url=(\/v\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+\?r=\d)$/.exec(v);
  if (!m) throw new Error(`unexpected Refresh header: ${v}`);
  return { delay: Number(m[1]), path: m[2]! };
}

describe("card retries", () => {
  it("answers a transient card failure with a self-retrying skeleton on the same signed path", async () => {
    const t = makeApp(rateLimited);
    const tok = token();
    const res = await t.view(`/v/${tok}/${EMAIL}`);
    expect(res.status).toBe(503);
    const { refresh, ...rest } = Object.fromEntries(res.headers);
    // Exactly the viewer's error-page headers (CSP with its sandbox, no-store), plus Refresh.
    expect(rest).toEqual(ERROR_HEADERS);
    expect(refresh).toBeDefined();
    const r = refreshOf(res)!;
    expect(r.path).toBe(`/v/${tok}/${EMAIL}?r=1`);
    expect([CARD_RETRY_DELAYS_SEC[0], CARD_RETRY_DELAYS_SEC[0] + 1]).toContain(r.delay);
    const html = await res.text();
    // A neutral loading skeleton: no script, no meta refresh (a sandboxed frame ignores it), no
    // error wording, no visible text at all.
    expect(html).not.toMatch(/<script|<meta http-equiv|unavailable|couldn't|error/i);
    expect(html).toContain('aria-busy="true"');
    expect(html.replace(/<title>[^<]*<\/title>|<style>[\s\S]*?<\/style>|<[^>]+>/g, "").trim()).toBe("");
    expect(t.app.stats.snapshot().view_card_retry).toBe(1);
    // edf-app got the plain path (the retry number never reaches it).
    expect(t.calls).toEqual([`${APP}/api/view-source/${tok}/${EMAIL}`]);
  });

  it("retries with growing delays, then settles on the error page", async () => {
    const t = makeApp(rateLimited);
    const tok = token();
    let path = `/v/${tok}/${EMAIL}`;
    const delays: number[] = [];
    for (;;) {
      const res = await t.view(path);
      expect(res.status).toBe(503);
      const r = refreshOf(res);
      if (r === null) {
        expect(await res.text()).toContain("Preview unavailable");
        break;
      }
      delays.push(r.delay);
      path = r.path;
    }
    expect(delays).toHaveLength(CARD_RETRY_DELAYS_SEC.length);
    delays.forEach((d, i) => expect(d - CARD_RETRY_DELAYS_SEC[i]!).toBeGreaterThanOrEqual(0));
    delays.forEach((d, i) => expect(d - CARD_RETRY_DELAYS_SEC[i]!).toBeLessThanOrEqual(1));
    expect(path).toBe(`/v/${tok}/${EMAIL}?r=${CARD_RETRY_DELAYS_SEC.length}`);
    expect(t.calls).toHaveLength(CARD_RETRY_DELAYS_SEC.length + 1);
  });

  it("a retry that succeeds serves the email exactly as a first load does", async () => {
    const t = makeApp(() => Response.json({ html: "<!DOCTYPE html>\n<p>hi</p>", height: 900 }));
    const tok = token();
    const res = await t.view(`/v/${tok}/${EMAIL}?r=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("refresh")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    expect(await res.text()).toBe("<!DOCTYPE html>\n<p>hi</p>");
    expect(t.calls).toEqual([`${APP}/api/view-source/${tok}/${EMAIL}`]);
  });

  it.each<[string, () => Response | Promise<Response>, number]>([
    ["the viewer quota (429)", () => Response.json({ error: "quota" }, { status: 429 }), 429],
    ["a 429 with any body", () => new Response("slow down", { status: 429 }), 429],
    ...[...TRANSIENT_UPSTREAM_ERRORS].map(
      (code) =>
        [`503 ${code}`, () => Response.json({ error: code }, { status: 503 }), 503] as [
          string,
          () => Response,
          number,
        ],
    ),
    ["an upstream timeout", () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), 504],
    ["a network error", () => Promise.reject(new TypeError("fetch failed")), 502],
  ])("retries %s", async (_name, appResponse, status) => {
    const res = await makeApp(appResponse).view(`/v/${token()}/${EMAIL}`);
    expect(res.status).toBe(status);
    expect(refreshOf(res)).not.toBeNull();
  });

  it.each<[string, () => Response]>([
    ["a disconnected mailbox", () => Response.json({ error: "mailbox_unavailable" }, { status: 503 })],
    ["Gmail's policy refusal", () => Response.json({ error: "gmail_policy" }, { status: 503 })],
    ["Gmail's daily limit", () => Response.json({ error: "gmail_daily_limit" }, { status: 503 })],
    ["an unknown failure", () => Response.json({ error: "fetch_failed" }, { status: 503 })],
    ["a non-JSON 503 (e.g. a paused deployment)", () => new Response("DEPLOYMENT_PAUSED", { status: 503 })],
    ["an oversized 503 body", () => Response.json({ error: "busy", pad: "x".repeat(4096) }, { status: 503 })],
    ["a deleted email", () => Response.json({ error: "deleted" }, { status: 404 })],
    ["a bad token", () => Response.json({ error: "bad_token" }, { status: 401 })],
    ["a server error", () => new Response("x", { status: 500 })],
    ["a bad body", () => Response.json({ html: 42, height: 1 })],
  ])("does not retry %s", async (_name, appResponse) => {
    const t = makeApp(appResponse);
    const res = await t.view(`/v/${token()}/${EMAIL}`);
    expect(res.headers.get("refresh")).toBeNull();
    expect(Object.fromEntries(res.headers)).toEqual(ERROR_HEADERS);
    expect(t.app.stats.snapshot().view_card_retry ?? 0).toBe(0);
  });

  it("only card views retry: the opened design keeps its error page", async () => {
    for (const mode of ["img", "noimg"] as const) {
      const res = await makeApp(rateLimited).view(`/v/${token(mode)}/${EMAIL}`);
      expect(res.status).toBe(503);
      expect(res.headers.get("refresh")).toBeNull();
      expect(await res.text()).toContain("Preview unavailable");
    }
  });

  it("never retries past the token: the refresh must land with time to spare", async () => {
    const soon = await makeApp(rateLimited).view(`/v/${token("card", nowSec() + CARD_RETRY_DELAYS_SEC[0] + CARD_RETRY_MIN_TOKEN_SEC - 1)}/${EMAIL}`);
    expect(soon.status).toBe(503);
    expect(soon.headers.get("refresh")).toBeNull();
    // With room for the longest delay (+1 s spread) it retries.
    const later = await makeApp(rateLimited).view(`/v/${token("card", nowSec() + CARD_RETRY_DELAYS_SEC[0] + 1 + CARD_RETRY_MIN_TOKEN_SEC + 2)}/${EMAIL}`);
    expect(refreshOf(later)).not.toBeNull();
    // An expired token is refused by the gate as before ("link has expired"), without forwarding.
    const t = makeApp(rateLimited);
    const expired = await t.view(`/v/v1.${nowSec() - 1}.card.${"A".repeat(43)}/${EMAIL}?r=1`);
    expect(expired.status).toBe(400);
    expect(expired.headers.get("refresh")).toBeNull();
    expect(t.calls).toHaveLength(0);
  });

  it("reads the retry number strictly; anything odd counts as the last retry", () => {
    const at = (q: string) => cardRetryAttempt(new URL(`${VIEW}/v/x/y${q}`));
    expect(at("")).toBe(0);
    expect(at("?r=1")).toBe(1);
    expect(at("?r=2")).toBe(2);
    for (const q of ["?r=0", "?r=9", "?r=99", "?r=-1", "?r=1.5", "?r=abc", "?r="]) {
      expect(at(q), q).toBe(CARD_RETRY_DELAYS_SEC.length);
    }
    // Vercel adds the rewrite's own query parameters; they don't matter.
    expect(at(`?r=1&token=a&emailId=b`)).toBe(1);
  });
});
