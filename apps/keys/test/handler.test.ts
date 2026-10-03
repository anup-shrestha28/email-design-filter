import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  KeyServiceWrapper,
  createDevOidcIssuer,
  dekWrapAad,
  mintDevOidcToken,
  open,
  seal,
} from "../../../packages/crypto/src/index";
import { WRAPPED_DEK_LENGTH, unwrapDek, wrapDek } from "../src/aead.js";
import { loadConfig, type KeysConfig } from "../src/config.js";
import { createKeysHandler, mailboxHash, type KeysHandler } from "../src/handler.js";
import {
  ANOMALY_CODE,
  MAX_REPORT_WINDOW_MS,
  OPS_ALERT_THRESHOLD,
  OPS_HARD_LIMIT,
  REFUSAL_ALERT_THRESHOLD,
} from "../src/monitor.js";
import { createVerifier } from "../src/oidc.js";

const ISSUER = "https://oidc.vercel.com/acme";
const AUD = "https://vercel.com/acme";
const APP_SUB = "owner:acme:project:edf-app:environment:production";
const KEYS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJrZXlzIn0.c2ln"; // opaque stand-in for edf-keys' own token
const MBX = "0192f0c4-7a1b-7c3d-9e8f-001122334455";

const dev = await createDevOidcIssuer({ issuer: ISSUER });
const appToken = (over: Partial<Parameters<typeof mintDevOidcToken>[1]> = {}) =>
  mintDevOidcToken(dev, { sub: APP_SUB, aud: AUD, ...over });

interface Harness {
  handle: KeysHandler;
  kek1: Buffer;
  kek2: Buffer;
  clock: { t: number };
  logs: Array<Record<string, string | number>>;
  calls: Array<{ url: string; init: RequestInit }>;
  pending: Promise<unknown>[];
}

function harness(
  opts: {
    active?: "v1" | "v2";
    alert?: boolean;
    alertWarning?: KeysConfig["alertWarning"];
    auditStatus?: number;
  } = {},
): Harness {
  const kek1 = randomBytes(32);
  const kek2 = randomBytes(32);
  const clock = { t: Date.parse("2026-09-27T12:00:00Z") };
  const logs: Harness["logs"] = [];
  const calls: Harness["calls"] = [];
  const pending: Promise<unknown>[] = [];
  const cfg: KeysConfig = {
    keks: new Map([
      ["v1", kek1],
      ["v2", kek2],
    ]),
    activeKid: opts.active ?? "v2",
    verify: createVerifier({ issuer: ISSUER, audience: AUD, subject: APP_SUB }, { jwks: dev.jwks }),
    appOrigin: "https://edf-app.example",
    auditUrl: "https://edf-app.example/api/keys-audit",
    auditToken: async (req) => req.headers.get("x-vercel-oidc-token"),
    alert:
      opts.alert === false ? null : { token: "github_pat_TESTTOKEN_0123456789", repo: "me/edf" },
    alertWarning: opts.alertWarning ?? null,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/issues?state=open&per_page=100")) {
        const open = calls.some((c) => c.url.endsWith("/issues") && c.init.method === "POST");
        return Response.json(
          open ? [{ number: 7, title: ANOMALY_CODE }] : [{ number: 1, title: "other" }],
        );
      }
      const status = url.includes("keys-audit") ? (opts.auditStatus ?? 204) : 201;
      return new Response(status === 204 ? null : "{}", { status }); // 204 must have no body
    }) as unknown as typeof fetch,
    now: () => clock.t,
    log: (e) => logs.push(e),
  };
  const inner = createKeysHandler({ ok: true, config: cfg });
  const handle: KeysHandler = (req) => inner(req, (p) => pending.push(p));
  return { handle, kek1, kek2, clock, logs, calls, pending };
}

async function post(
  h: Harness,
  body: unknown,
  over: {
    token?: string | null;
    headers?: Record<string, string>;
    raw?: string;
    path?: string;
  } = {},
) {
  const token = over.token === undefined ? await appToken() : over.token;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-vercel-oidc-token": KEYS_TOKEN,
    ...over.headers,
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return h.handle(
    new Request(`https://edf-keys.example${over.path ?? "/unwrap"}`, {
      method: "POST",
      headers,
      body: over.raw ?? JSON.stringify(body),
    }),
  );
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe("ops", () => {
  it("generate returns a DEK wrapped under the active KEK with AAD [label, mailboxId, kekVersion]", async () => {
    const res = await post(h, { op: "generate", mailboxId: MBX });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { dek: string; wrapped: string; kekVersion: string };
    expect(body.kekVersion).toBe("keys:v2");
    const dek = Buffer.from(body.dek, "base64");
    const wrapped = Buffer.from(body.wrapped, "base64");
    expect(dek.length).toBe(32);
    expect(wrapped.length).toBe(WRAPPED_DEK_LENGTH);
    // cross-format: @edf/crypto opens what edf-keys sealed
    expect(open(h.kek2, wrapped, dekWrapAad(MBX, "keys:v2")).equals(dek)).toBe(true);
  });

  it("unwrap round-trips and re-wraps lazily from a non-active KEK", async () => {
    const dek = randomBytes(32);
    const oldWrapped = seal(h.kek1, dek, dekWrapAad(MBX, "keys:v1")); // wrapped by @edf/crypto
    const res = await post(h, {
      op: "unwrap",
      mailboxId: MBX,
      wrapped: oldWrapped.toString("base64"),
      kekVersion: "keys:v1",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dek: string;
      rewrapped: { wrapped: string; kekVersion: string } | null;
    };
    expect(Buffer.from(body.dek, "base64").equals(dek)).toBe(true);
    expect(body.rewrapped?.kekVersion).toBe("keys:v2");
    const again = await post(h, {
      op: "unwrap",
      mailboxId: MBX,
      wrapped: body.rewrapped!.wrapped,
      kekVersion: "keys:v2",
    });
    expect(((await again.json()) as { rewrapped: unknown }).rewrapped).toBeNull();
  });

  it("works end-to-end with @edf/crypto KeyServiceWrapper", async () => {
    const wrapper = new KeyServiceWrapper({
      origin: "https://edf-keys.example",
      getOidcToken: () => appToken(),
      fetchImpl: ((url: string, init: RequestInit) =>
        h.handle(new Request(url, init))) as unknown as typeof fetch,
    });
    const g = await wrapper.generate({ mailboxId: MBX });
    const u = await wrapper.unwrap({
      mailboxId: MBX,
      wrapped: g.wrapped,
      kekVersion: g.kekVersion,
    });
    expect(u.dek.equals(g.dek)).toBe(true);
    expect(u.rewrapped).toBeNull();
  });
});

describe("refusals", () => {
  const unwrapBody = () => {
    const wrapped = wrapDek(h.kek2, randomBytes(32), MBX, "keys:v2");
    return {
      op: "unwrap",
      mailboxId: MBX,
      wrapped: wrapped.toString("base64"),
      kekVersion: "keys:v2",
    };
  };

  it("rejects non-POST and unknown paths", async () => {
    const res = await h.handle(new Request("https://edf-keys.example/unwrap", { method: "GET" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await post(h, unwrapBody(), { path: "/other" })).status).toBe(404);
    // A direct call to the function path bypasses a path-conditioned edge rule: refused, before
    // the OIDC check and without reading the body.
    const direct = await post(h, unwrapBody(), { path: "/api/unwrap" });
    expect(direct.status).toBe(404);
    expect(await direct.json()).toEqual({ error: "not_found" });
    expect((await post(h, unwrapBody(), { path: "/unwrap" })).status).toBe(200);
  });

  it("rejects missing, malformed and wrong OIDC tokens", async () => {
    const b = unwrapBody();
    for (const token of [
      null,
      "not-a-jwt",
      await appToken({ ttlSec: 3600 }), // 1-hour build token
      await appToken({ sub: "owner:acme:project:edf-view:environment:production" }),
      await appToken({ sub: "owner:acme:project:edf-app:environment:preview" }),
      await appToken({ aud: "https://vercel.com/other" }),
      await appToken({ issuer: "https://oidc.vercel.com/other" }),
      await appToken({ iat: Math.floor(Date.now() / 1000) - 8000 }),
    ]) {
      const res = await post(h, b, { token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(
      (await post(h, b, { headers: { authorization: `Basic ${await appToken()}` }, token: null }))
        .status,
    ).toBe(401);
  });

  it("rejects oversize bodies (declared or streamed) and wrong content types", async () => {
    expect(
      (
        await post(h, null, {
          raw: JSON.stringify({ op: "generate", mailboxId: MBX, pad: "x".repeat(5000) }),
        })
      ).status,
    ).toBe(413);
    const token = await appToken();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1000));
        c.close();
      },
    });
    const res = await h.handle(
      new Request("https://edf-keys.example/unwrap", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(
      (await post(h, unwrapBody(), { headers: { "content-type": "text/plain" } })).status,
    ).toBe(415);
  });

  it("rejects malformed JSON and anything outside the strict schema", async () => {
    const good = unwrapBody();
    for (const raw of [
      "{",
      "[]",
      '"x"',
      JSON.stringify({ op: "delete", mailboxId: MBX }),
      JSON.stringify({ op: "generate", mailboxId: "../x" }),
      JSON.stringify({ op: "generate", mailboxId: MBX, extra: 1 }),
      JSON.stringify({ ...good, wrapped: "!!!" }),
      JSON.stringify({ ...good, wrapped: randomBytes(60).toString("base64") }),
      JSON.stringify({ ...good, wrapped: good.wrapped.replace(/=*$/, "") }), // non-canonical padding
      JSON.stringify({ ...good, kekVersion: "local:v1" }),
      JSON.stringify({ ...good, kekVersion: "keys:" }),
    ]) {
      expect((await post(h, null, { raw })).status, raw).toBe(400);
    }
  });

  it("refuses unknown KEKs, tampering and wrong mailbox binding", async () => {
    const good = unwrapBody();
    expect(await (await post(h, { ...good, kekVersion: "keys:v9" })).json()).toEqual({
      error: "unknown_kek",
    });
    const t = Buffer.from(good.wrapped, "base64");
    t[20] = (t[20] as number) ^ 1;
    expect(await (await post(h, { ...good, wrapped: t.toString("base64") })).json()).toEqual({
      error: "unwrap_failed",
    });
    expect((await post(h, { ...good, mailboxId: "another-mailbox" })).status).toBe(400);
    expect((await post(h, { ...good, kekVersion: "keys:v1" })).status).toBe(400); // wrong KEK version bound in AAD
  });

  it("rate-limits per instance", async () => {
    const hh = harness({ alert: false });
    for (let i = 0; i < OPS_HARD_LIMIT; i++) {
      expect((await post(hh, { op: "generate", mailboxId: MBX })).status).toBe(200);
    }
    const res = await post(hh, { op: "generate", mailboxId: MBX });
    expect(res.status).toBe(429);
    hh.clock.t += 11 * 60 * 1000;
    expect((await post(hh, { op: "generate", mailboxId: MBX })).status).toBe(200);
  });

  it("returns 503 on misconfiguration (fail closed)", async () => {
    const logs: unknown[] = [];
    for (const env of [
      {},
      { TOKEN_KEKS: '{"v1":"short"}', TOKEN_KEK_ACTIVE: "v1" },
      {
        TOKEN_KEKS: JSON.stringify({ v1: randomBytes(32).toString("base64") }),
        TOKEN_KEK_ACTIVE: "v2",
      },
      {
        TOKEN_KEKS: JSON.stringify({ v1: randomBytes(32).toString("base64") }),
        TOKEN_KEK_ACTIVE: "v1",
        OIDC_ISSUER: ISSUER,
        APP_OIDC_SUB: APP_SUB,
        KEYS_AUD: AUD,
        APP_ORIGIN: "https://edf-app.example",
        VERCEL_TOKEN: "leaked",
      },
    ]) {
      const handle = createKeysHandler(loadConfig(env as NodeJS.ProcessEnv), (e) => logs.push(e));
      const res = await handle(new Request("https://edf-keys.example/unwrap", { method: "POST" }));
      expect(res.status).toBe(503);
    }
    const ok = loadConfig({
      TOKEN_KEKS: JSON.stringify({ v1: randomBytes(32).toString("base64") }),
      TOKEN_KEK_ACTIVE: "v1",
      OIDC_ISSUER: ISSUER,
      APP_OIDC_SUB: APP_SUB,
      KEYS_AUD: AUD,
      APP_ORIGIN: "https://edf-app.example",
    } as NodeJS.ProcessEnv);
    expect(ok.ok).toBe(true);
  });

  it("degrades a missing or malformed alert channel to a warning, never a 503", async () => {
    const base = {
      NODE_ENV: "production",
      TOKEN_KEKS: JSON.stringify({ v1: randomBytes(32).toString("base64") }),
      TOKEN_KEK_ACTIVE: "v1",
      OIDC_ISSUER: ISSUER,
      APP_OIDC_SUB: APP_SUB,
      KEYS_AUD: AUD,
      APP_ORIGIN: "https://edf-app.example",
    };
    const cases: Array<[Record<string, string>, "missing" | "invalid"]> = [
      [{}, "missing"],
      [{ GITHUB_ALERT_REPO: "me/edf" }, "invalid"],
      [{ KEYS_ALERT_TOKEN: "github_pat_TESTTOKEN_0123456789" }, "invalid"],
      [{ KEYS_ALERT_TOKEN: "bad token!", GITHUB_ALERT_REPO: "me/edf" }, "invalid"],
    ];
    for (const [extra, reason] of cases) {
      const logs: Array<Record<string, string | number>> = [];
      const result = loadConfig({ ...base, ...extra } as NodeJS.ProcessEnv, {
        log: (e) => logs.push(e),
      });
      expect(result.ok, reason).toBe(true);
      if (!result.ok) continue;
      expect(result.config.alert).toBeNull();
      expect(result.config.alertWarning).toBe(reason);
      const handle = createKeysHandler(result);
      expect(logs).toEqual([
        expect.objectContaining({ ev: "warning", code: "alert_unconfigured", reason }),
      ]);
      // Requests are served (here: refused for the missing OIDC token), not 503.
      const res = await handle(new Request("https://edf-keys.example/unwrap", { method: "POST" }));
      expect(res.status).toBe(401);
      await handle(new Request("https://edf-keys.example/unwrap", { method: "POST" }));
      expect(logs.filter((e) => e.ev === "warning")).toHaveLength(1); // once per instance
    }
    // A pasted trailing newline is not a malformed token.
    const trimmed = loadConfig({
      ...base,
      KEYS_ALERT_TOKEN: "github_pat_TESTTOKEN_0123456789\n",
      GITHUB_ALERT_REPO: " me/edf ",
    } as NodeJS.ProcessEnv);
    expect(trimmed.ok && trimmed.config.alert).toEqual({
      token: "github_pat_TESTTOKEN_0123456789",
      repo: "me/edf",
    });
    expect(trimmed.ok && trimmed.config.alertWarning).toBeNull();
  });
});

describe("monitoring", () => {
  it("opens the KEYS_UNWRAP_ANOMALY issue once, then comments, content-free", async () => {
    for (let i = 0; i < OPS_ALERT_THRESHOLD; i++) await post(h, { op: "generate", mailboxId: MBX });
    await Promise.all(h.pending);
    const created = h.calls.filter(
      (c) => c.url === "https://api.github.com/repos/me/edf/issues" && c.init.method === "POST",
    );
    expect(created).toHaveLength(1);
    const payload = JSON.parse(created[0]!.init.body as string) as { title: string; body: string };
    expect(payload.title).toBe(ANOMALY_CODE);
    expect(payload.body).toContain(`Unwrap + generate: ${OPS_ALERT_THRESHOLD}`);
    expect(payload.body).not.toContain(MBX);
    expect(payload.body).not.toContain(mailboxHash(MBX));
    expect((created[0]!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer github_pat_TESTTOKEN_0123456789",
    );
    // Within the cooldown: no second alert.
    await post(h, { op: "generate", mailboxId: MBX });
    await Promise.all(h.pending);
    expect(
      h.calls.filter((c) => c.url.includes("api.github.com") && c.init.method === "POST"),
    ).toHaveLength(1);
    // After the cooldown, refusal flood → comment on the existing issue.
    h.clock.t += 31 * 60 * 1000;
    for (let i = 0; i < REFUSAL_ALERT_THRESHOLD; i++) await post(h, {}, { token: null });
    await Promise.all(h.pending);
    expect(
      h.calls.some((c) => c.url.endsWith("/issues/7/comments") && c.init.method === "POST"),
    ).toBe(true);
  });

  it("POSTs content-free counts to /api/keys-audit at most once a minute with its own OIDC token", async () => {
    await post(h, { op: "generate", mailboxId: MBX });
    await post(h, {}, { token: null });
    await Promise.all(h.pending);
    expect(h.calls.filter((c) => c.url.includes("keys-audit"))).toHaveLength(0); // < 1 minute
    h.clock.t += 61_000;
    await post(h, { op: "generate", mailboxId: MBX });
    await Promise.all(h.pending);
    const audits = h.calls.filter((c) => c.url === "https://edf-app.example/api/keys-audit");
    expect(audits).toHaveLength(1);
    expect((audits[0]!.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEYS_TOKEN}`,
    );
    expect(audits[0]!.init.redirect).toBe("error");
    const body = JSON.parse(audits[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["counts", "v", "windowEnd", "windowStart"]);
    expect(body).toMatchObject({ v: 1, counts: { generate_ok: 2, refused_oidc: 1 } });
    expect(body.windowEnd as number).toBeGreaterThan(body.windowStart as number);
    for (const k of Object.keys(body.counts as object)) expect(k).toMatch(/^[a-z0-9_]{1,40}$/);
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`${MBX}|${mailboxHash(MBX)}`));
    // Another request within the minute: no second report.
    await post(h, { op: "generate", mailboxId: MBX });
    await Promise.all(h.pending);
    expect(h.calls.filter((c) => c.url.includes("keys-audit"))).toHaveLength(1);
  });

  it("keeps counts when the audit POST fails and retries after a minute", async () => {
    const hh = harness({ auditStatus: 500 });
    await post(hh, { op: "generate", mailboxId: MBX });
    hh.clock.t += 61_000;
    await post(hh, { op: "generate", mailboxId: MBX });
    await Promise.all(hh.pending);
    hh.clock.t += 61_000;
    await post(hh, { op: "generate", mailboxId: MBX });
    await Promise.all(hh.pending);
    const audits = hh.calls.filter((c) => c.url.includes("keys-audit"));
    expect(audits).toHaveLength(2);
    expect(JSON.parse(audits[1]!.init.body as string).counts.generate_ok).toBe(3);
  });

  it("adds alert_unconfigured to every audit report while alerting is off", async () => {
    const hh = harness({ alert: false, alertWarning: "missing" });
    for (let i = 0; i < 3; i++) {
      await post(hh, { op: "generate", mailboxId: MBX });
      await Promise.all(hh.pending);
      hh.clock.t += 61_000;
    }
    const audits = hh.calls.filter((c) => c.url.includes("keys-audit"));
    expect(audits).toHaveLength(2);
    for (const a of audits)
      expect(JSON.parse(a.init.body as string).counts).toMatchObject({ alert_unconfigured: 1 });
    // The default harness (alerting configured) never sends it.
    await post(h, { op: "generate", mailboxId: MBX });
    h.clock.t += 61_000;
    await post(h, { op: "generate", mailboxId: MBX });
    await Promise.all(h.pending);
    const [ok] = h.calls.filter((c) => c.url.includes("keys-audit"));
    expect(JSON.parse(ok!.init.body as string).counts).not.toHaveProperty("alert_unconfigured");
  });

  it("keeps report windows within edf-app's 86,400 s limit after long audit failures", async () => {
    const opts = { auditStatus: 401 };
    const hh = harness(opts);
    await post(hh, { op: "generate", mailboxId: MBX });
    // A day and more of failed reports on a warm instance.
    for (let i = 0; i < 26; i++) {
      hh.clock.t += 60 * 60 * 1000;
      await post(hh, { op: "generate", mailboxId: MBX });
      await Promise.all(hh.pending);
    }
    opts.auditStatus = 204;
    hh.clock.t += 61_000;
    await post(hh, { op: "generate", mailboxId: MBX });
    await Promise.all(hh.pending);
    const audits = hh.calls.filter((c) => c.url.includes("keys-audit"));
    const last = JSON.parse(audits.at(-1)!.init.body as string) as {
      windowStart: number;
      windowEnd: number;
      counts: Record<string, number>;
    };
    expect(last.windowEnd - last.windowStart).toBeLessThanOrEqual(MAX_REPORT_WINDOW_MS / 1000);
    expect(last.windowEnd - last.windowStart).toBeGreaterThan(86_000);
    expect(last.counts).toMatchObject({ generate_ok: 28, window_clamped: 1 });
    // The next report covers only the time since the last delivered one.
    hh.clock.t += 61_000;
    await post(hh, { op: "generate", mailboxId: MBX });
    await Promise.all(hh.pending);
    const next = JSON.parse(
      hh.calls.filter((c) => c.url.includes("keys-audit")).at(-1)!.init.body as string,
    ) as { windowStart: number; windowEnd: number; counts: object };
    expect(next.windowEnd - next.windowStart).toBe(61);
    expect(next.counts).not.toHaveProperty("window_clamped");
  });

  it("never logs key material, tokens or mailbox ids", async () => {
    const good = wrapDek(h.kek2, randomBytes(32), MBX, "keys:v2");
    const token = await appToken();
    await post(
      h,
      { op: "unwrap", mailboxId: MBX, wrapped: good.toString("base64"), kekVersion: "keys:v9" },
      { token },
    );
    await post(h, { op: "generate", mailboxId: MBX }, { token: "garbage.token.x" });
    const text = JSON.stringify(h.logs);
    for (const secret of [
      MBX,
      token,
      h.kek1.toString("base64"),
      h.kek2.toString("base64"),
      good.toString("base64"),
      "garbage.token.x",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain(mailboxHash(MBX));
  });
});

describe("aead mirror", () => {
  it("rejects every single-byte flip and wrong bindings", () => {
    const dek = randomBytes(32);
    const w = wrapDek(h.kek1, dek, MBX, "keys:v1");
    expect(unwrapDek(h.kek1, w, MBX, "keys:v1")?.equals(dek)).toBe(true);
    for (let i = 0; i < w.length; i++) {
      const t = Buffer.from(w);
      t[i] = (t[i] as number) ^ 0x80;
      expect(unwrapDek(h.kek1, t, MBX, "keys:v1")).toBeNull();
    }
    expect(unwrapDek(h.kek2, w, MBX, "keys:v1")).toBeNull();
    expect(unwrapDek(h.kek1, w, "other", "keys:v1")).toBeNull();
    expect(unwrapDek(h.kek1, w, MBX, "keys:v2")).toBeNull();
  });
});
