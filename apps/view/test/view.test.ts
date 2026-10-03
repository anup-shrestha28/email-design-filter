import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchImage as realFetchImage, sniffImage, type ImageFetchResult } from "@edf/fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  IMAGE_TOKEN_MAX_BYTES as CRYPTO_IMAGE_TOKEN_MAX_BYTES,
  createDevOidcIssuer,
  createOidcVerifier,
  imageTokenExpiry,
  parseEd25519SigningRing,
  parseKeyring,
  signImageToken,
  signViewToken,
  type ImageTokenClaims,
} from "../../../packages/crypto/src/index";
import { setTestOverrides } from "../../../packages/fetch/src/testing";
import { createViewApp, MAX_IMAGE_RESPONSE_BYTES, type ViewApp } from "../src/app";
import { EMAIL_BUDGET_BYTES } from "../src/budget";
import { loadViewConfig } from "../src/config";
import { TRANSPARENT_GIF, UNAVAILABLE_SVG, viewCsp } from "../src/http";
import { devTokenSource } from "../src/oidc";
import {
  IMAGE_TOKEN_MAX_BYTES,
  gateViewToken,
  parseImagePublicKeys,
  verifyImageToken,
} from "../src/tokens";

const APP = "https://edf-app.example";
const VIEW = "https://edf-view.example";
const EDF_VIEW_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ2aWV3In0.c2ln";
const EMAIL = "0192f0c4-7a1b-7c3d-9e8f-001122334455";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUB = JSON.stringify({
  v1: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
});
const signing = parseEd25519SigningRing(
  JSON.stringify({ v1: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") }),
);
const other = generateKeyPairSync("ed25519");
const otherSigning = parseEd25519SigningRing(
  JSON.stringify({
    v1: other.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  }),
);
const viewRing = parseKeyring(JSON.stringify({ v1: randomBytes(32).toString("base64") }));

const cfg = loadViewConfig({ IMG_PUBKEYS: PUB, APP_ORIGIN: APP, VIEW_ORIGIN: VIEW });
if (!cfg.ok) throw new Error(cfg.code);
const CONFIG = cfg.config;

interface Call {
  url: string;
  init: RequestInit;
}

function makeApp(
  opts: {
    appResponse?: () => Response | Promise<Response>;
    image?: (url: string, o: { maxBytes: number }) => Promise<ImageFetchResult>;
    clock?: { t: number };
    statsResponse?: () => Promise<Response>;
  } = {},
) {
  const calls: Call[] = [];
  const imageCalls: Array<{ url: string; maxBytes: number }> = [];
  const clock = opts.clock ?? { t: Date.now() };
  const pending: Promise<unknown>[] = [];
  /** Delayed stats reports (stats.ts scheduleTrailing): kept apart so `pending` settles without them. */
  const trailing: Promise<unknown>[] = [];
  /** Timers the delayed reports sleep on; `fireTimers()` ends them. */
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const app: ViewApp = createViewApp({
    config: CONFIG,
    token: async (req) => req.headers.get("x-vercel-oidc-token"),
    fetchApp: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/view-stats"))
        return opts.statsResponse ? opts.statsResponse() : new Response(null, { status: 204 });
      return opts.appResponse
        ? opts.appResponse()
        : Response.json({ html: "<!DOCTYPE html>\n<html><body>hi</body></html>", height: 900 });
    }) as unknown as typeof fetch,
    fetchImage: async (url, o) => {
      imageCalls.push({ url, maxBytes: o.maxBytes });
      return opts.image
        ? opts.image(url, o)
        : {
            ok: true,
            format: "png",
            width: 1,
            height: 1,
            contentType: "image/png",
            body: Buffer.from("PNGBYTES"),
          };
    },
    now: () => clock.t,
    log: () => undefined,
    sleep: (ms) => new Promise<void>((fire) => timers.push({ ms, fire })),
  });
  const wait = (p: Promise<unknown>) =>
    void (p === app.stats.trailing ? trailing : pending).push(p);
  const req = (path: string, init: RequestInit = {}) =>
    new Request(`${VIEW}${path}`, {
      ...init,
      headers: {
        "x-vercel-oidc-token": EDF_VIEW_TOKEN,
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  return {
    app,
    calls,
    imageCalls,
    clock,
    pending,
    trailing,
    timers,
    /** Let every scheduled delayed report fire (the clock moves by its delay first) and settle. */
    fireTimers: async () => {
      const due = timers.splice(0);
      if (due.length > 0) clock.t += Math.max(...due.map((d) => d.ms));
      for (const d of due) d.fire();
      await Promise.all([...pending, ...trailing]);
    },
    view: (path: string, init?: RequestInit) => app.view(req(path, init), wait),
    img: (path: string, init?: RequestInit) => app.img(req(path, init), wait),
    /** No waitUntil (a runtime that offers none). */
    imgNoWait: (path: string, init?: RequestInit) => app.img(req(path, init)),
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const viewToken = (exp = nowSec() + 240) =>
  signViewToken(viewRing, { userId: "u1", emailId: EMAIL, exp, mode: "img" });
function imageToken(over: Partial<ImageTokenClaims> = {}, ring = signing): string {
  return signImageToken(ring, {
    u: "u1",
    e: EMAIL,
    x: imageTokenExpiry(new Date()),
    url: "https://cdn.shop.example/a.png",
    mb: 1_000_000,
    b: "bud-1",
    ...over,
  });
}

/** Error pages: never cached. A served email differs only in cache-control (see below). */
const EXACT_VIEW_HEADERS = {
  "cache-control": "private, no-store",
  "content-security-policy": `default-src 'none'; img-src ${VIEW}/img/ data:; style-src 'unsafe-inline'; font-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${APP}; sandbox allow-popups allow-popups-to-escape-sandbox`,
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

describe("GET /v/:token/:emailId", () => {
  it("forwards a fresh token with edf-view's OIDC token and serves the HTML with exactly the §9.3 headers", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock });
    const token = viewToken(Math.floor(clock.t / 1000) + 240);
    const res = await t.view(`/v/${token}/${EMAIL}`);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      ...EXACT_VIEW_HEADERS,
      "cache-control": "private, max-age=240",
    });
    expect(await res.text()).toBe("<!DOCTYPE html>\n<html><body>hi</body></html>");
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.url).toBe(`${APP}/api/view-source/${token}/${EMAIL}`);
    expect((t.calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${EDF_VIEW_TOKEN}`,
    );
    expect(t.calls[0]!.init.redirect).toBe("error");
    expect(viewCsp(CONFIG)).toBe(EXACT_VIEW_HEADERS["content-security-policy"]);
  });

  it("lets the browser (never a shared cache) keep a served email only until its token expires", async () => {
    const nowS = nowSec(); // signViewToken checks exp against the real clock
    const clock = { t: nowS * 1000 };
    // The upstream takes 7 s: the lifetime counts from when the response leaves, never past exp.
    const t = makeApp({
      clock,
      appResponse: () => {
        clock.t += 7000;
        return Response.json({ html: "<!DOCTYPE html>\n<p>x</p>", height: 900 });
      },
    });
    const cache = async (exp: number) => {
      const res = await t.view(`/v/${viewToken(exp)}/${EMAIL}`);
      expect(res.status).toBe(200);
      return res.headers.get("cache-control");
    };
    clock.t = nowS * 1000;
    expect(await cache(nowS + 240)).toBe("private, max-age=233");
    clock.t = nowS * 1000;
    expect(await cache(nowS + 60)).toBe("private, max-age=53");
    clock.t = nowS * 1000;
    // Expired while the upstream answered: served once, but not stored.
    expect(await cache(nowS + 5)).toBe("private, no-store");
    for (const value of [await cache(nowS + 240), EXACT_VIEW_HEADERS["cache-control"]]) {
      expect(value).not.toMatch(/public|s-maxage|immutable/);
    }
  });

  it("serves only the rewritten public path; direct /api/v calls are refused without forwarding", async () => {
    const t = makeApp();
    const token = viewToken();
    // Vercel keeps the original path on a rewrite and adds the destination's query parameters.
    expect((await t.view(`/v/${token}/${EMAIL}?token=${token}&emailId=${EMAIL}`)).status).toBe(200);
    expect(t.calls).toHaveLength(1);
    for (const path of [
      `/api/v?token=${token}&emailId=${EMAIL}`,
      `/api/v/${token}/${EMAIL}`,
      `/?token=${token}&emailId=${EMAIL}`,
    ]) {
      expect((await t.view(path)).status, path).toBe(404);
    }
    expect(t.calls).toHaveLength(1);
    expect(t.app.stats.snapshot().view_rejected_format).toBe(3);
  });

  it("refuses encoded, empty and trailing path segments before any gate or forwarding", async () => {
    const t = makeApp();
    const token = viewToken();
    for (const path of [
      `/v/${token.replaceAll(".", "%2E")}/${EMAIL}`,
      `/v/${token}/${EMAIL}%2F..`,
      `/v/${token}/${EMAIL}%00`,
      `/v/${token}/${EMAIL}/`,
      `/v/${token}/${EMAIL}/..`,
      `//v/${token}/${EMAIL}`,
      `/v//${token}/${EMAIL}`,
      `/%76/${token}/${EMAIL}`,
      `/api/v/.%2e/..%2f/v/${token}/${EMAIL}`,
    ]) {
      expect((await t.view(path)).status, path).toBe(404);
    }
    expect(t.calls).toHaveLength(0);
    // Dot segments are collapsed by URL parsing before any code runs: the handler sees (and
    // forwards) only the canonical /v/ path, never an /api/ one.
    const dotted = `/api/v/%2e%2e/%2E%2e/v/${token}/${EMAIL}`;
    expect(new URL(new Request(`${VIEW}${dotted}`).url).pathname).toBe(`/v/${token}/${EMAIL}`);
    expect((await t.view(dotted)).status).toBe(200);
    expect(t.calls.map((c) => c.url)).toEqual([`${APP}/api/view-source/${token}/${EMAIL}`]);
  });

  it("drops expired, far-future and malformed tokens without forwarding", async () => {
    const t = makeApp();
    const now = nowSec();
    for (const path of [
      `/v/v1.${now - 1}.img.${"A".repeat(43)}/${EMAIL}`,
      `/v/v1.${now + 301}.img.${"A".repeat(43)}/${EMAIL}`,
      `/v/v1.${now + 100}.img.short/${EMAIL}`,
      `/v/v1.${now + 100}.IMG.${"A".repeat(43)}/${EMAIL}`,
      `/v/${viewToken()}/${"x".repeat(65)}`,
      `/v/garbage/${EMAIL}`,
    ]) {
      const res = await t.view(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("content-security-policy")).toBe(
        EXACT_VIEW_HEADERS["content-security-policy"],
      );
    }
    expect((await t.view(`/v/${viewToken()}`)).status).toBe(404);
    expect((await t.view(`/v/${viewToken()}/..%2F..%2Fadmin`)).status).toBe(404);
    expect(t.calls).toHaveLength(0);
    expect(t.app.stats.snapshot()).toMatchObject({
      view_rejected_expiry: 2,
      view_rejected_format: 6,
    });
  });

  it("maps upstream failures to a neutral error page with the same headers", async () => {
    const cases: Array<[() => Response | Promise<Response>, number]> = [
      [() => new Response("nope", { status: 404 }), 404],
      [() => new Response("gone", { status: 410 }), 404],
      [() => new Response("x", { status: 401 }), 403],
      [() => new Response("x", { status: 429 }), 429],
      [() => new Response("x", { status: 500 }), 502],
      [() => Response.json({ error: "unavailable" }, { status: 503 }), 503],
      [
        () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
        502,
      ],
      [() => Response.json({ html: 42, height: 1 }), 502],
      [() => Response.json({ html: "<p>x</p>", height: -1 }), 502],
      [
        () =>
          new Response("x".repeat(5 * 1024 * 1024), {
            headers: { "content-type": "application/json" },
          }),
        502,
      ],
      [() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })), 504],
      [() => Promise.reject(new TypeError("fetch failed")), 502],
    ];
    for (const [appResponse, status] of cases) {
      const t = makeApp({ appResponse });
      const res = await t.view(`/v/${viewToken()}/${EMAIL}`);
      expect(res.status).toBe(status);
      expect(Object.fromEntries(res.headers)).toEqual(EXACT_VIEW_HEADERS);
      expect(await res.text()).not.toMatch(/nope|gone|<html>x/);
    }
  });

  it("refuses without its own OIDC token and for non-GET", async () => {
    const t = makeApp();
    const noToken = await t.app.view(new Request(`${VIEW}/v/${viewToken()}/${EMAIL}`));
    expect(noToken.status).toBe(503);
    expect((await t.view(`/v/${viewToken()}/${EMAIL}`, { method: "POST" })).status).toBe(405);
    expect(t.calls).toHaveLength(0);
  });
});

describe("GET /img/:token", () => {
  it("serves a verified image with the §9.3 headers and the capped allowance", async () => {
    const t = makeApp();
    const res = await t.img(`/img/${imageToken({ mb: 2 * 1024 * 1024 })}`);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toEqual({
      // Tokens live ≥ 24 h (midnight + 24 h), so the browser keeps it for the CDN's day.
      "cache-control": "public, max-age=86400, s-maxage=86400, immutable",
      "content-length": "8",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
    });
    expect(t.imageCalls).toEqual([
      {
        url: "https://cdn.shop.example/a.png",
        maxBytes: Math.min(2 * 1024 * 1024, MAX_IMAGE_RESPONSE_BYTES),
      },
    ]);
  });

  it("rejects bad signatures, unknown kids, expired and garbage tokens without fetching", async () => {
    const t = makeApp();
    const valid = imageToken();
    for (const tok of [
      imageToken({}, otherSigning),
      `v2${valid.slice(2)}`,
      imageToken({ x: nowSec() + 5 }).replace(/.$/, "B"),
      "garbage",
      `${valid}x`,
    ]) {
      const res = await t.img(`/img/${encodeURIComponent(tok)}`);
      expect(res.status).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("content-type")).toBe("image/svg+xml");
    }
    const expired = makeApp({ clock: { t: Date.now() + 49 * 3600 * 1000 } });
    expect((await expired.img(`/img/${valid}`)).status).toBe(403);
    expect(t.imageCalls).toHaveLength(0);
    expect(t.app.stats.snapshot().img_bad_signature).toBe(5);
  });

  it("serves only the rewritten public path; direct /api/img calls are refused without fetching", async () => {
    const t = makeApp();
    const tok = imageToken();
    expect((await t.img(`/img/${tok}?token=${tok}`)).status).toBe(200);
    for (const path of [`/api/img?token=${tok}`, `/api/img/${tok}`]) {
      const res = await t.img(path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(t.imageCalls).toHaveLength(1);
  });

  it("refuses encoded, empty and trailing path segments without fetching", async () => {
    const t = makeApp();
    const tok = imageToken();
    for (const path of [
      `/img/${tok.replaceAll(".", "%2E")}`,
      `/img/${tok}%2F`,
      `/img/${tok}/`,
      `/img/${tok}/..%2f`,
      `//img/${tok}`,
      `/%69mg/${tok}`,
    ]) {
      const res = await t.img(path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(t.imageCalls).toHaveLength(0);
    expect((await t.img(`/api/img/%2e%2e/%2e%2e/img/${tok}`)).status).toBe(200);
    expect(t.imageCalls).toHaveLength(1);
  });

  it("accepts edf-app's per-email budget id and shares that budget across the email's images", async () => {
    const t = makeApp({
      image: async (_u, o) => ({
        ok: true,
        format: "png",
        width: 1,
        height: 1,
        contentType: "image/png",
        body: Buffer.alloc(o.maxBytes),
      }),
    });
    const x = imageTokenExpiry(new Date());
    const b = `${EMAIL}_${x.toString(36)}`; // as apps/web/src/server/view-source.ts mints it
    const mb = 2 * 1024 * 1024;
    let served = 0;
    for (let i = 0; i < 9; i++) {
      const res = await t.img(
        `/img/${imageToken({ x, b, mb, url: `https://cdn.shop.example/${i}.png` })}`,
      );
      if (res.headers.get("content-type") === "image/png")
        served += Number(res.headers.get("content-length"));
    }
    expect(served).toBe(EMAIL_BUDGET_BYTES);
    const sibling = "0192f0c4-7a1b-7c3d-9e8f-00112233ffff";
    const res = await t.img(
      `/img/${imageToken({ x, e: sibling, b: `${sibling}_${x.toString(36)}`, mb })}`,
    );
    expect(Number(res.headers.get("content-length"))).toBe(mb);
  });

  it("bounds the browser's max-age by the image token's remaining life", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock });
    const x = Math.floor(clock.t / 1000) + 600;
    const ok = await t.img(`/img/${imageToken({ x })}`);
    expect(ok.headers.get("cache-control")).toBe("public, max-age=600, s-maxage=86400, immutable");
    const tracker = await t.img(
      `/img/${imageToken({ x, url: "https://us1.list-manage.com/track/open.php?u=1" })}`,
    );
    expect(tracker.headers.get("cache-control")).toBe(
      "public, max-age=600, s-maxage=86400, immutable",
    );
  });

  it("answers tracker hosts with a 1×1 transparent GIF", async () => {
    const t = makeApp();
    const res = await t.img(
      `/img/${imageToken({ url: "https://us1.list-manage.com/track/open.php?u=1" })}`,
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(TRANSPARENT_GIF)).toBe(true);
    expect(t.imageCalls).toHaveLength(0);
  });

  it("serves a neutral placeholder on fetch failures, caching only deterministic ones long", async () => {
    const cases: Array<[ImageFetchResult, string]> = [
      [{ ok: false, reason: "not_image" }, "public, max-age=86400, s-maxage=86400, immutable"],
      [{ ok: false, reason: "too_large" }, "public, max-age=86400, s-maxage=86400, immutable"],
      [
        { ok: false, reason: "blocked_address" },
        "public, max-age=86400, s-maxage=86400, immutable",
      ],
      [{ ok: false, reason: "timeout" }, "public, s-maxage=300"],
      [{ ok: false, reason: "http", status: 503 }, "public, s-maxage=300"],
    ];
    for (const [result, cache] of cases) {
      const t = makeApp({ image: async () => result });
      const res = await t.img(`/img/${imageToken()}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(cache);
      expect(Buffer.from(await res.arrayBuffer()).equals(UNAVAILABLE_SVG)).toBe(true);
    }
  });

  it("enforces the per-email budget in memory", async () => {
    const t = makeApp({
      image: async (_u, o) => ({
        ok: true,
        format: "png",
        width: 1,
        height: 1,
        contentType: "image/png",
        body: Buffer.alloc(o.maxBytes),
      }),
    });
    const mb = 2 * 1024 * 1024;
    let served = 0;
    for (let i = 0; i < 10; i++) {
      const res = await t.img(
        `/img/${imageToken({ mb, url: `https://cdn.shop.example/${i}.png` })}`,
      );
      if (res.headers.get("content-type") === "image/png")
        served += Number(res.headers.get("content-length"));
    }
    expect(served).toBe(EMAIL_BUDGET_BYTES);
    expect(t.imageCalls.at(-1)?.maxBytes).toBeLessThan(mb); // the last fetch was capped to what was left
    const res = await t.img(
      `/img/${imageToken({ mb, url: "https://cdn.shop.example/extra.png" })}`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(t.app.stats.snapshot().img_budget_exceeded).toBeGreaterThanOrEqual(1);
    // Another email's budget is independent.
    expect((await t.img(`/img/${imageToken({ b: "bud-2" })}`)).headers.get("content-type")).toBe(
      "image/png",
    );
  });

  it("keeps separate budgets for emails and users that share a budget id", async () => {
    const t = makeApp({
      image: async (_u, o) => ({
        ok: true,
        format: "png",
        width: 1,
        height: 1,
        contentType: "image/png",
        body: Buffer.alloc(o.maxBytes),
      }),
    });
    const mb = 2 * 1024 * 1024;
    // edf-app used to derive `b` from the first 8 hex chars of a uuidv7 id plus the expiry day, so
    // emails inserted in the same ~65 s window (for any user) shared a `b`; such tokens live 48 h.
    for (let i = 0; i < 8; i++)
      await t.img(`/img/${imageToken({ mb, url: `https://cdn.shop.example/${i}.png` })}`);
    const again = await t.img(`/img/${imageToken({ mb, url: "https://cdn.shop.example/x.png" })}`);
    expect(again.headers.get("cache-control")).toBe("no-store");
    const sibling = "0192f0c4-8c00-7c3d-9e8f-001122334455";
    for (const over of [{ e: sibling }, { u: "u2" }, { u: "u2", e: sibling }]) {
      const res = await t.img(`/img/${imageToken({ ...over, mb })}`);
      expect(res.headers.get("content-type"), JSON.stringify(over)).toBe("image/png");
      expect(Number(res.headers.get("content-length"))).toBe(mb);
    }
  });

  it("serves a one-picture mailer's 3–5 MB hero whole: 5 MB allowances verify, larger ones don't", async () => {
    const MB = 1024 * 1024;
    const hero = 4_728_575; // the size of a real hero PNG from the 2026-09-30 audit (grey at 2 MB)
    const t = makeApp({
      image: async () => ({
        ok: true,
        format: "png",
        width: 1200,
        height: 4000,
        contentType: "image/png",
        body: Buffer.alloc(hero),
      }),
    });
    expect(IMAGE_TOKEN_MAX_BYTES).toBe(5 * MB);
    expect(IMAGE_TOKEN_MAX_BYTES).toBe(CRYPTO_IMAGE_TOKEN_MAX_BYTES); // edf-view mirrors edf-app
    expect(MAX_IMAGE_RESPONSE_BYTES).toBe(5 * MB);
    const res = await t.img(`/img/${imageToken({ mb: 5 * MB })}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Number(res.headers.get("content-length"))).toBe(hero);
    expect((await res.arrayBuffer()).byteLength).toBe(hero);
    expect(t.imageCalls).toEqual([{ url: "https://cdn.shop.example/a.png", maxBytes: 5 * MB }]);
    // Signed by hand (@edf/crypto refuses to sign over its ceiling): a larger allowance is refused.
    const payload = Buffer.from(
      JSON.stringify([
        "img/v1",
        "u1",
        EMAIL,
        imageTokenExpiry(new Date()),
        "https://cdn.shop.example/a.png",
        5 * MB + 1,
        "bud-1",
      ]),
    );
    const over = `v1.${payload.toString("base64url")}.${sign(null, payload, privateKey).toString("base64url")}`;
    expect(verifyImageToken(parseImagePublicKeys(PUB)!, over, nowSec())).toBeNull();
    expect((await t.img(`/img/${over}`)).status).toBe(403);
    expect(t.imageCalls).toHaveLength(1);
  });

  it("the tracker answer is a valid 1×1 GIF", () => {
    expect(sniffImage(TRANSPARENT_GIF)).toEqual({ format: "gif", width: 1, height: 1 });
  });

  it("the 'Picture unavailable' placeholder is a constant, script-free SVG with the old GIF's 1×1 footprint", () => {
    const svg = UNAVAILABLE_SVG.toString("utf8");
    // One root <svg> in the SVG namespace, intrinsic 1 × 1 px (ratio 1:1, so a failed image keeps
    // the box it had with the 1×1 GIF), drawing in a 100 × 100 viewBox.
    expect(svg).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1" height="1" viewBox="0 0 100 100" preserveAspectRatio="xMidYMin meet">/,
    );
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg.match(/<svg\b/g)).toHaveLength(1);
    // Nothing that could run, load or link: no script, event handlers, links, foreign content,
    // external images, CSS imports or url() references, no entities or DOCTYPE.
    expect(svg).not.toMatch(
      /<script|\son[a-z]+=|href|<a[\s>]|<foreignObject|<image|<use|@import|url\(|<!|&|javascript:|data:/i,
    );
    // Only these elements.
    expect(new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]))).toEqual(
      new Set(["svg", "style", "rect", "g", "circle", "path", "text"]),
    );
    expect(svg).toContain(">Picture unavailable</text>");
    // Small: it is served for every image that can't be shown.
    expect(UNAVAILABLE_SVG.length).toBeLessThan(2048);
    // Not a raster image: the proxy's sniffer (which never lets an email's own SVG through) says no.
    expect(sniffImage(UNAVAILABLE_SVG)).toBeNull();
  });

  it("serves the placeholder at /img/unavailable without a token or a fetch, cacheable for a day", async () => {
    const t = makeApp();
    const res = await t.img("/img/unavailable");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, s-maxage=86400, immutable",
    );
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(UNAVAILABLE_SVG)).toBe(true);
    expect(t.imageCalls).toHaveLength(0);
    const snap = t.app.stats.snapshot();
    expect(snap.img_bad_signature ?? 0).toBe(0);
    expect(snap.img_bytes_served ?? 0).toBe(0);
    // Only that exact segment: anything else is still a token, and a bad one.
    for (const path of ["/img/unavailable.svg", "/img/Unavailable", "/img/unavailable/x"])
      expect((await t.img(path)).status, path).toBe(403);
  });

  it("answers a budget-limited fetch with the placeholder and no-store, so a later view can load it", async () => {
    const MB = 1024 * 1024;
    const t = makeApp({
      image: async (_u, o) =>
        o.maxBytes >= 4 * MB
          ? {
              ok: true,
              format: "png",
              width: 1,
              height: 1,
              contentType: "image/png",
              body: Buffer.alloc(4 * MB),
            }
          : { ok: false, reason: "too_large" },
    });
    const b = "bud-limit";
    // 3 × 4 MB of the email's 15 MB served; the 4th 4 MB image may only use the 3 MB left.
    for (let i = 0; i < 3; i++) {
      const res = await t.img(
        `/img/${imageToken({ b, mb: 5 * MB, url: `https://cdn.shop.example/${i}.png` })}`,
      );
      expect(res.headers.get("content-type")).toBe("image/png");
    }
    const limited = await t.img(
      `/img/${imageToken({ b, mb: 5 * MB, url: "https://cdn.shop.example/3.png" })}`,
    );
    expect(t.imageCalls.at(-1)?.maxBytes).toBe(3 * MB);
    expect(limited.headers.get("content-type")).toBe("image/svg+xml");
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await limited.arrayBuffer()).equals(UNAVAILABLE_SVG)).toBe(true);
    // Over its own allowance, not the budget: cached for the token's life (it would fail again).
    const big = makeApp({ image: async () => ({ ok: false, reason: "too_large" }) });
    const own = await big.img(`/img/${imageToken({ mb: 1 * MB })}`);
    expect(own.headers.get("content-type")).toBe("image/svg+xml");
    expect(own.headers.get("cache-control")).toMatch(
      /^public, max-age=\d+, s-maxage=86400, immutable$/,
    );
  });
});

describe("image proxy through the real SSRF-safe fetcher", () => {
  let server: Server;
  let port = 0;
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(45);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/ok.png")
        return void res.writeHead(200, { "content-type": "image/png" }).end(png(40, 20));
      if (req.url === "/big.png")
        return void res
          .writeHead(200, { "content-type": "image/png" })
          .end(Buffer.concat([png(40, 20), Buffer.alloc(300_000)]));
      if (req.url === "/hero.png" || req.url === "/huge.png")
        return void res
          .writeHead(200, { "content-type": "image/png" })
          .end(
            Buffer.concat([
              png(1200, 4000),
              Buffer.alloc(req.url === "/hero.png" ? 4_700_000 : 5 * 1024 * 1024),
            ]),
          );
      if (req.url === "/page")
        return void res.writeHead(200, { "content-type": "text/html" }).end("<script>x</script>");
      if (req.url === "/fake.png")
        return void res
          .writeHead(200, { "content-type": "image/png" })
          .end("<svg onload=alert(1)>");
      if (req.url === "/redirect")
        return void res
          .writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" })
          .end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    setTestOverrides({ trustedHosts: new Map([["img.test", "127.0.0.1"]]), extraPorts: [port] });
  });
  afterAll(async () => {
    setTestOverrides(null);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function realApp(mb = 100_000) {
    const app = createViewApp({
      config: CONFIG,
      token: async () => EDF_VIEW_TOKEN,
      fetchApp: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      fetchImage: realFetchImage,
      now: Date.now,
      log: () => undefined,
    });
    return (path: string) =>
      app.img(
        new Request(`${VIEW}/img/${imageToken({ url: `http://img.test:${port}${path}`, mb })}`),
      );
  }

  it("happy path, oversize, non-image, disguised SVG and a redirect to metadata", async () => {
    const get = realApp();
    const ok = await get("/ok.png");
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(sniffImage(Buffer.from(await ok.arrayBuffer()))).toEqual({
      format: "png",
      width: 40,
      height: 20,
    });
    for (const p of ["/big.png", "/page", "/fake.png", "/redirect"]) {
      const res = await get(p);
      expect(res.headers.get("content-type"), p).toBe("image/svg+xml");
      expect(Buffer.from(await res.arrayBuffer()).equals(UNAVAILABLE_SVG)).toBe(true);
    }
  });

  it("a 5 MB allowance brings a 4.7 MB hero through the real fetcher; one byte over 5 MB is a placeholder", async () => {
    const get = realApp(5 * 1024 * 1024);
    const hero = await get("/hero.png");
    expect(hero.headers.get("content-type")).toBe("image/png");
    expect((await hero.arrayBuffer()).byteLength).toBe(45 + 4_700_000);
    const huge = await get("/huge.png");
    expect(huge.headers.get("content-type")).toBe("image/svg+xml");
    expect(Buffer.from(await huge.arrayBuffer()).equals(UNAVAILABLE_SVG)).toBe(true);
  });
});

describe("stats", () => {
  it("POSTs content-free counts to /api/view-stats at most once a minute with its own OIDC token", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock });
    await t.view(`/v/${viewToken()}/${EMAIL}`);
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(t.calls.filter((c) => c.url.endsWith("/api/view-stats"))).toHaveLength(0);
    clock.t += 61_000;
    await t.img(`/img/${imageToken({ x: Math.floor(clock.t / 1000) + 3600 })}`);
    await Promise.all(t.pending);
    const posts = t.calls.filter((c) => c.url === `${APP}/api/view-stats`);
    expect(posts).toHaveLength(1);
    expect((posts[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${EDF_VIEW_TOKEN}`,
    );
    const body = JSON.parse(posts[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["counts", "v", "windowEnd", "windowStart"]);
    expect(body.v).toBe(1);
    expect(body.counts).toEqual({
      view_requests: 1,
      view_forwarded: 1,
      img_requests: 2,
      img_bad_signature: 1,
      img_ok: 1,
      img_bytes_served: 8,
    });
    for (const k of Object.keys(body.counts as object)) expect(k).toMatch(/^[a-z0-9_]{1,40}$/);
    expect((posts[0]!.init.body as string).length).toBeLessThanOrEqual(4096);
    expect(posts[0]!.init.body as string).not.toMatch(/cdn\.shop|u1|0192f0c4/);
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(t.calls.filter((c) => c.url.endsWith("/api/view-stats"))).toHaveLength(1);
  });

  it("reports a gallery card's served image bytes separately (budget ids ending in _c)", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock });
    const x = Math.floor(clock.t / 1000) + 3600;
    await t.img(`/img/${imageToken({ x, b: `${EMAIL}_${x.toString(36)}_c` })}`);
    await t.img(`/img/${imageToken({ x, b: `${EMAIL}_${x.toString(36)}` })}`);
    clock.t += 61_000;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    const posts = t.calls.filter((c) => c.url === `${APP}/api/view-stats`);
    expect(posts).toHaveLength(1);
    const counts = (JSON.parse(posts[0]!.init.body as string) as { counts: Record<string, number> })
      .counts;
    expect(counts.img_bytes_served).toBe(16);
    expect(counts.img_card_bytes_served).toBe(8);
  });
});

describe("stats flushing (60 s, or 4 MB pending, never within 10 s; a delayed report 12 s after image bytes)", () => {
  const MB = 1024 * 1024;
  const bigImage = (bytes: number) => async (): Promise<ImageFetchResult> => ({
    ok: true,
    format: "png",
    width: 1,
    height: 1,
    contentType: "image/png",
    body: Buffer.alloc(bytes),
  });
  const reports = (t: ReturnType<typeof makeApp>) =>
    t.calls
      .filter((c) => c.url === `${APP}/api/view-stats`)
      .map((c) => (JSON.parse(c.init.body as string) as { counts: Record<string, number> }).counts);

  it("reports once 4 MB of served image bytes are pending, but never within 10 s of the last report", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock, image: bigImage(2 * MB) });
    const x = Math.floor(clock.t / 1000) + 3600;
    const tok = (i: number) =>
      imageToken({ x, url: `https://cdn.shop.example/p${i}.png`, mb: 2 * MB });
    await t.img(`/img/${tok(1)}`);
    await t.img(`/img/${tok(2)}`); // 4 MB pending, but only 0 s since the instance started
    clock.t += 9_999;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(0);
    clock.t += 1; // 10 s
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(1);
    expect(reports(t)[0]!.img_bytes_served).toBe(4 * MB);

    // Another 4 MB a second later: held until 10 s after that report.
    clock.t += 1_000;
    await t.img(`/img/${tok(3)}`);
    await t.img(`/img/${tok(4)}`);
    clock.t += 8_000;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(1);
    clock.t += 1_000;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(2);
    expect(reports(t)[1]!.img_bytes_served).toBe(4 * MB);
  });

  it("below 4 MB it reports only once 60 s have passed", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock, image: bigImage(1.95 * MB) });
    const x = Math.floor(clock.t / 1000) + 3600;
    await t.img(`/img/${imageToken({ x, url: "https://cdn.shop.example/p1.png", mb: 2 * MB })}`);
    await t.img(`/img/${imageToken({ x, url: "https://cdn.shop.example/p2.png", mb: 2 * MB })}`);
    clock.t += 59_999;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(0);
    clock.t += 1;
    await t.img(`/img/garbage`);
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(1);
    expect(reports(t)[0]!.img_bytes_served).toBe(2 * Math.floor(1.95 * MB));
  });

  it("the report runs under waitUntil: the response never waits for it", async () => {
    const clock = { t: Date.now() };
    let release: (r: Response) => void = () => undefined;
    const t = makeApp({ clock, statsResponse: () => new Promise<Response>((r) => (release = r)) });
    await t.img(`/img/garbage`);
    clock.t += 61_000;
    const res = await t.img(`/img/garbage`); // resolves while the report is still in flight
    expect(res.status).toBe(403);
    expect(t.pending.length).toBeGreaterThan(0);
    expect(reports(t)).toHaveLength(1);
    let done = false;
    void Promise.all(t.pending).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    release(new Response(null, { status: 204 }));
    await Promise.all(t.pending);
    expect(t.app.stats.snapshot()).toEqual({});
  });

  it("sparse traffic: bytes served after a cold start and then silence go out in one delayed report", async () => {
    const { STATS_TRAILING_MS } = await import("../src/stats");
    const clock = { t: Date.now() };
    const t = makeApp({ clock, image: bigImage(300 * 1024) });
    const x = Math.floor(clock.t / 1000) + 3600;
    // A gallery page right after a cold start: < 4 MB, < 10 s, and no request afterwards.
    for (let i = 0; i < 9; i++) {
      clock.t += 200;
      await t.img(
        `/img/${imageToken({ x, url: `https://cdn.shop.example/c${i}.png`, b: `${EMAIL}_${x.toString(36)}_c`, mb: MB })}`,
      );
    }
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(0);
    // One timer for the whole burst, handed to waitUntil.
    expect(t.timers.map((d) => d.ms)).toEqual([STATS_TRAILING_MS]);
    expect(t.trailing).toHaveLength(1);
    await t.fireTimers();
    expect(reports(t)).toHaveLength(1);
    expect(reports(t)[0]!.img_bytes_served).toBe(9 * 300 * 1024);
    expect(reports(t)[0]!.img_card_bytes_served).toBe(9 * 300 * 1024);
    expect(t.app.stats.snapshot()).toEqual({});
    expect(t.app.stats.trailing).toBeNull();
  });

  it("the delayed report stands down if a report goes out first; the next image schedules a fresh one", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock, image: bigImage(2 * MB) });
    const x = Math.floor(clock.t / 1000) + 3600;
    const tok = (i: number) =>
      imageToken({ x, url: `https://cdn.shop.example/p${i}.png`, mb: 2 * MB });
    await t.img(`/img/${tok(1)}`); // schedules the delayed report
    clock.t += 10_000;
    await t.img(`/img/${tok(2)}`); // 4 MB pending, 10 s: reported in-request
    await Promise.all(t.pending);
    expect(reports(t)).toHaveLength(1);
    expect(t.app.stats.trailing).toBeNull();
    const first = t.timers.splice(0);
    expect(first).toHaveLength(1);
    await t.img(`/img/${tok(3)}`); // pending again: a fresh delayed report
    expect(t.timers).toHaveLength(1);
    clock.t += 5_000;
    for (const d of first) d.fire(); // the superseded one fires: nothing sent
    await Promise.all([...t.pending, t.trailing[0]]);
    expect(reports(t)).toHaveLength(1);
    await t.fireTimers();
    expect(reports(t)).toHaveLength(2);
    expect(reports(t)[1]!.img_bytes_served).toBe(2 * MB);
  });

  it("no delayed report without pending image bytes, or without waitUntil", async () => {
    const clock = { t: Date.now() };
    const t = makeApp({ clock });
    await t.view(`/v/${viewToken()}/${EMAIL}`);
    await t.img(`/img/garbage`);
    expect(t.timers).toHaveLength(0);
    await t.imgNoWait(`/img/${imageToken({ x: Math.floor(clock.t / 1000) + 3600 })}`);
    expect(t.app.stats.snapshot().img_bytes_served).toBe(8);
    expect(t.timers).toHaveLength(0);
    expect(t.app.stats.trailing).toBeNull();
  });

  it("a failed report re-queues its counts, and the retry keeps the 10 s spacing", async () => {
    const { Stats } = await import("../src/stats");
    const clock = { t: 0 };
    let up = false;
    const bodies: Array<{ counts: Record<string, number> }> = [];
    const deps = {
      statsUrl: `${APP}/api/view-stats`,
      token: async () => EDF_VIEW_TOKEN,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        if (!up) return new Response(null, { status: 503 });
        bodies.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
      now: () => clock.t,
      log: () => undefined,
    };
    const s = new Stats(0);
    s.add("img_bytes_served", 5 * MB);
    clock.t = 10_000;
    expect(s.due(clock.t)).toBe(true);
    await s.maybeFlush(deps, new Request(VIEW)); // fails
    expect(s.snapshot().img_bytes_served).toBe(5 * MB);
    up = true;
    clock.t = 19_999;
    expect(s.due(clock.t)).toBe(false);
    await s.maybeFlush(deps, new Request(VIEW));
    expect(bodies).toHaveLength(0);
    clock.t = 20_000;
    await s.maybeFlush(deps, new Request(VIEW));
    expect(bodies.map((b) => b.counts.img_bytes_served)).toEqual([5 * MB]);
    expect(s.snapshot()).toEqual({});
  });
});

describe("cross-verification with @edf/crypto", () => {
  it("image tokens signed by @edf/crypto verify in edf-view; tampered ones don't", () => {
    const keys = parseImagePublicKeys(PUB)!;
    const c: ImageTokenClaims = {
      u: "user_1",
      e: EMAIL,
      x: imageTokenExpiry(new Date()),
      url: "https://cdn.shop.example/x.png?w=600",
      mb: 12345,
      b: "b1",
    };
    const token = signImageToken(signing, c);
    expect(verifyImageToken(keys, token, nowSec())).toEqual(c);
    expect(verifyImageToken(keys, signImageToken(otherSigning, c), nowSec())).toBeNull();
  });

  it("view tokens minted by @edf/crypto pass the gate", () => {
    const token = viewToken(nowSec() + 300);
    expect(gateViewToken(token, nowSec())).toMatchObject({ ok: true });
    expect(gateViewToken(token, nowSec() + 301)).toMatchObject({ ok: false, reason: "expired" });
  });

  it("edf-view dev OIDC tokens verify with @edf/crypto's verifier", async () => {
    const dev = await createDevOidcIssuer();
    const sub = "owner:edf-dev:project:edf-view:environment:development";
    const aud = "https://vercel.com/edf-dev";
    const source = devTokenSource(JSON.stringify(dev.privateJwk), {
      issuer: dev.issuer,
      subject: sub,
      audience: aud,
    });
    const token = await source(new Request("http://localhost/"));
    const verify = createOidcVerifier(
      { issuer: dev.issuer, audience: aud, subject: sub },
      { jwks: dev.jwks },
    );
    expect(await verify(token!)).toEqual({ sub });
  });
});

describe("config", () => {
  it("refuses private keys, shared origins, http origins and Vercel tokens", () => {
    const priv = JSON.stringify({
      v1: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    expect(loadViewConfig({ IMG_PUBKEYS: priv, APP_ORIGIN: APP, VIEW_ORIGIN: VIEW })).toEqual({
      ok: false,
      code: "img_pubkeys",
    });
    expect(loadViewConfig({ IMG_PUBKEYS: PUB, APP_ORIGIN: APP, VIEW_ORIGIN: APP })).toEqual({
      ok: false,
      code: "origins_not_separate",
    });
    expect(
      loadViewConfig({ IMG_PUBKEYS: PUB, APP_ORIGIN: "http://edf-app.example", VIEW_ORIGIN: VIEW }),
    ).toEqual({ ok: false, code: "app_origin" });
    expect(loadViewConfig({ IMG_PUBKEYS: PUB, APP_ORIGIN: `${APP}/`, VIEW_ORIGIN: VIEW })).toEqual({
      ok: false,
      code: "app_origin",
    });
    expect(
      loadViewConfig({ IMG_PUBKEYS: PUB, APP_ORIGIN: APP, VIEW_ORIGIN: VIEW, VERCEL_TOKEN: "x" }),
    ).toEqual({ ok: false, code: "vercel_token_present" });
    expect(
      loadViewConfig(
        { IMG_PUBKEYS: PUB, APP_ORIGIN: APP, VIEW_ORIGIN: VIEW, NODE_ENV: "production" },
        { dev: true },
      ),
    ).toEqual({ ok: false, code: "dev_in_production" });
  });
});

describe("stats window cap", () => {
  it("never sends a window longer than 86,400 s, so reporting recovers after a long outage", async () => {
    const { Stats } = await import("../src/stats");
    const clock = { t: 1_700_000_000_000 };
    let appUp = false;
    const bodies: Array<{
      windowStart: number;
      windowEnd: number;
      counts: Record<string, number>;
    }> = [];
    const deps = {
      statsUrl: `${APP}/api/view-stats`,
      token: async () => EDF_VIEW_TOKEN,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(init.body as string) as (typeof bodies)[number];
        // edf-app's /api/view-stats schema (apps/web/src/server/service-counts.ts).
        if (!appUp) return new Response(null, { status: 503 });
        if (b.windowEnd < b.windowStart || b.windowEnd - b.windowStart > 86_400)
          return new Response(null, { status: 400 });
        bodies.push(b);
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
      now: () => clock.t,
      log: () => undefined,
    };
    const s = new Stats(clock.t);
    // edf-app is down for 30 h while the instance keeps serving.
    for (let h = 0; h < 30; h++) {
      s.add("view_requests");
      clock.t += 3600 * 1000;
      await s.maybeFlush(deps, new Request(VIEW));
    }
    appUp = true;
    s.add("view_requests");
    clock.t += 61_000;
    await s.maybeFlush(deps, new Request(VIEW));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.windowEnd - bodies[0]!.windowStart).toBeLessThanOrEqual(86_400);
    expect(bodies[0]!.counts.view_requests).toBe(31);
    expect(s.snapshot()).toEqual({});
  });
});

describe("stats value cap", () => {
  it("caps each count at 10,000,000 per report and carries the rest over", async () => {
    const { Stats } = await import("../src/stats");
    const clock = { t: 0 };
    const bodies: Array<{ counts: Record<string, number> }> = [];
    const deps = {
      statsUrl: `${APP}/api/view-stats`,
      token: async () => EDF_VIEW_TOKEN,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
      now: () => clock.t,
      log: () => undefined,
    };
    const s = new Stats(0);
    s.add("img_bytes_served", 25_000_000);
    clock.t = 61_000;
    await s.maybeFlush(deps, new Request(VIEW));
    clock.t = 122_000;
    await s.maybeFlush(deps, new Request(VIEW));
    clock.t = 183_000;
    await s.maybeFlush(deps, new Request(VIEW));
    expect(bodies.map((b) => b.counts.img_bytes_served)).toEqual([
      10_000_000, 10_000_000, 5_000_000,
    ]);
  });
});

describe("firewall notes stay in step with FREE-TIER.md §8.4", () => {
  it("the routeParams comment describes the all-requests rate limit and the deny-/api/ rule", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const docs = readFileSync(new URL("../../../docs/FREE-TIER.md", import.meta.url), "utf8");
    const start = src.indexOf("Only the public path forms are accepted.");
    const end = src.indexOf("function routeParams(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const comment = src.slice(start, end).replace(/\s*\*\s*/g, " ");
    // §8.4: the edf-view rate-limit rule has no path condition, and a second rule denies /api/*.
    expect(docs).toContain("**all requests, with no path condition**");
    expect(docs).toContain("**Deny: request path starts with `/api/`**");
    expect(comment).not.toMatch(/sit outside the edf-view\s+WAF rate-limit rule/);
    expect(comment).toContain("no path condition");
    expect(comment).toContain("starting with `/api/`");
  });
});
