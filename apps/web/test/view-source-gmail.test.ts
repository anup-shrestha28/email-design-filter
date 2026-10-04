/**
 * The viewer's live Gmail fetch (view-source.ts): transient failures are retried with bounded,
 * jittered backoff inside a time budget (quota reserved per attempt), permanent ones never, and
 * one server instance keeps at most VIEWER_GMAIL_CONCURRENCY fetches in flight per mailbox. Plus
 * the card image allowance, whose total no longer grows with the image cap. No real network: the
 * GmailClient is a fake and every timer is injected or short.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signViewToken } from "@edf/crypto";
import { GmailError, type GmailErrorKind } from "@edf/gmail";
import type * as GmailModule from "@edf/gmail";
import { withUser } from "@edf/db";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, seedEmail } from "./support/db";

const gmail = vi.hoisted(() => ({
  /** What the next messagesGet calls do, in order (then: succeed). */
  script: [] as Array<"ok" | { kind: string; retryAfterMs?: number } | Promise<void>>,
  calls: 0,
  inFlight: 0,
  maxInFlight: 0,
  reserves: 0,
  options: [] as Array<Record<string, unknown>>,
  raw: "",
}));
vi.mock("@/server/fixtures", () => ({ isFixtureAccount: () => false, readFixtureRaw: async () => null }));
vi.mock("@/server/pipeline-deps", () => ({
  pipelineDeps: async () => ({ tokens: { forMailbox: () => async () => "access-token" } }),
}));
vi.mock("@edf/gmail", async (importOriginal) => {
  const m = await importOriginal<typeof GmailModule>();
  class FakeGmailClient {
    constructor(opts: Record<string, unknown>) {
      gmail.options.push(opts);
    }
    async messagesGet() {
      gmail.calls++;
      gmail.inFlight++;
      gmail.maxInFlight = Math.max(gmail.maxInFlight, gmail.inFlight);
      try {
        const step = gmail.script.shift() ?? "ok";
        if (step instanceof Promise) await step;
        else if (step !== "ok")
          throw new m.GmailError(step.kind as GmailErrorKind, { method: "users.messages.get", status: 429, retryAfterMs: step.retryAfterMs ?? null });
        return { id: "m1", raw: gmail.raw };
      } finally {
        gmail.inFlight--;
      }
    }
  }
  return {
    ...m,
    GmailClient: FakeGmailClient,
    reserveQuota: (...args: Parameters<typeof m.reserveQuota>) => {
      gmail.reserves++;
      return m.reserveQuota(...args);
    },
  };
});

const rawEmail = (html: string) =>
  Buffer.from(
    ["From: Northwind <hello@northwind.example>", "To: someone@gmail.example", "Subject: Sale", "MIME-Version: 1.0", "Content-Type: text/html; charset=utf-8", "", html, ""].join("\r\n"),
  ).toString("base64url");

const gmailError = (kind: GmailErrorKind, retryAfterMs: number | null = null) =>
  new GmailError(kind, { method: "users.messages.get", status: 429, retryAfterMs });

afterAll(async () => {
  if (!HAS_DB) return;
  const { getPool } = await import("@/server/db");
  await (await getPool()).end();
});

describe("fetchForViewer (retries)", () => {
  async function run(errors: Array<GmailError | Error>, o: { deadlineMs?: number; reserve?: () => Promise<boolean> } = {}) {
    const { fetchForViewer } = await import("@/server/view-source");
    let t = 0;
    const sleeps: number[] = [];
    let reserves = 0;
    let fetches = 0;
    const result = fetchForViewer({
      reserve: o.reserve ?? (async () => (reserves++, true)),
      fetch: async () => {
        fetches++;
        const e = errors.shift();
        if (e) throw e;
        return "raw";
      },
      deadline: o.deadlineMs ?? 8_000,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      random: () => 0.5,
    }).then(
      (v) => ({ ok: true as const, v }),
      (err: unknown) => ({ ok: false as const, err }),
    );
    return { r: await result, sleeps, reserves: () => reserves, fetches: () => fetches };
  }

  it("retries Gmail's rate limit after the wait Gmail asked for (plus ≤ 250 ms jitter), reserving quota per attempt", async () => {
    const x = await run([gmailError("rate_limited", 1_500), gmailError("rate_limited", 2_000)]);
    expect(x.r).toEqual({ ok: true, v: "raw" });
    expect(x.sleeps).toEqual([1_625, 2_125]);
    expect(x.fetches()).toBe(3);
    expect(x.reserves()).toBe(3);
  });

  it("retries server and network failures with a short growing backoff, at most 3 attempts in all", async () => {
    const last = gmailError("network");
    const x = await run([gmailError("server"), gmailError("network"), last, gmailError("server")]);
    expect(x.r).toEqual({ ok: false, err: last });
    expect(x.sleeps).toEqual([625, 1_125]);
    expect(x.fetches()).toBe(3);
  });

  it.each(["not_found", "policy", "daily_limit", "unauthorized", "bad_request", "too_large", "bad_response", "history_expired"] as const)(
    "never retries %s",
    async (kind) => {
      const err = gmailError(kind);
      const x = await run([err]);
      expect(x.r).toEqual({ ok: false, err });
      expect(x.fetches()).toBe(1);
      expect(x.sleeps).toEqual([]);
    },
  );

  it("never retries a non-Gmail error", async () => {
    const err = new Error("boom");
    const x = await run([err]);
    expect(x.r).toEqual({ ok: false, err });
    expect(x.fetches()).toBe(1);
  });

  it("gives up at once when the wait would pass the budget (a long Retry-After)", async () => {
    const err = gmailError("rate_limited", 30_000);
    const x = await run([err]);
    expect(x.r).toEqual({ ok: false, err });
    expect(x.sleeps).toEqual([]);
    // Budget left for one retry but not two.
    const y = await run([gmailError("rate_limited", 3_000), gmailError("rate_limited", 5_000)], { deadlineMs: 6_000 });
    expect(y.r.ok).toBe(false);
    expect(y.sleeps).toEqual([3_125]);
    expect(y.fetches()).toBe(2);
  });

  it("a refused quota reservation ends the view as 429 quota, before or between attempts", async () => {
    const { ViewerFetchRefused } = await import("@/server/view-source");
    const none = await run([], { reserve: async () => false });
    expect(none.r.ok).toBe(false);
    expect(!none.r.ok && none.r.err).toBeInstanceOf(ViewerFetchRefused);
    expect(!none.r.ok && (none.r.err as InstanceType<typeof ViewerFetchRefused>).status).toBe(429);
    expect(none.fetches()).toBe(0);
    let left = 1;
    const second = await run([gmailError("rate_limited", 1_000)], { reserve: async () => left-- > 0 });
    expect(!second.r.ok && second.r.err).toBeInstanceOf(ViewerFetchRefused);
    expect(second.fetches()).toBe(1);
  });

  it("stays well inside edf-view's 25 s and the gallery's 15 s slot", async () => {
    const { VIEWER_GMAIL_START_BUDGET_MS, VIEWER_GMAIL_TIMEOUT_MS, VIEWER_GMAIL_MAX_ATTEMPTS } = await import("@/server/view-source");
    // No attempt starts after the start budget, and the last one times out after its own limit.
    expect(VIEWER_GMAIL_START_BUDGET_MS + VIEWER_GMAIL_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(VIEWER_GMAIL_START_BUDGET_MS).toBeLessThan(15_000);
    expect(VIEWER_GMAIL_MAX_ATTEMPTS).toBe(3);
  });
});

describe("KeyedSemaphore (per-mailbox limit)", () => {
  it("keeps at most `limit` in flight per key, hands slots over in order, and forgets idle keys", async () => {
    const { KeyedSemaphore } = await import("@/server/view-source");
    const s = new KeyedSemaphore(3, 10);
    const held = await Promise.all([s.acquire("a", 1000), s.acquire("a", 1000), s.acquire("a", 1000)]);
    expect(held.every((r) => typeof r === "function")).toBe(true);
    expect(s.inFlight("a")).toBe(3);
    // Another key is independent.
    const b = await s.acquire("b", 0);
    expect(typeof b).toBe("function");
    const order: number[] = [];
    const w1 = s.acquire("a", 5_000).then((r) => (order.push(1), r));
    const w2 = s.acquire("a", 5_000).then((r) => (order.push(2), r));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    held[0]!();
    held[0]!(); // a second release is ignored
    const r1 = await w1;
    expect(order).toEqual([1]);
    expect(s.inFlight("a")).toBe(3);
    held[1]!();
    const r2 = await w2;
    expect(order).toEqual([1, 2]);
    for (const r of [held[2], r1, r2, b]) r!();
    expect(s.size).toBe(0);
  });

  it("a wait that runs out resolves null and leaves the queue; a full queue refuses at once", async () => {
    const { KeyedSemaphore } = await import("@/server/view-source");
    const s = new KeyedSemaphore(1, 1);
    const first = await s.acquire("m", 0);
    expect(await s.acquire("m", 20)).toBeNull(); // timed out
    const waiting = s.acquire("m", 5_000);
    expect(await s.acquire("m", 5_000)).toBeNull(); // queue (1) full
    expect(await s.acquire("m", 0)).toBeNull(); // no wait allowed
    first!();
    const next = await waiting;
    expect(typeof next).toBe("function");
    next!();
    expect(s.size).toBe(0);
  });

  it("the viewer's limiter allows 3 per mailbox", async () => {
    const { viewerGmailSlots, VIEWER_GMAIL_CONCURRENCY } = await import("@/server/view-source");
    expect(VIEWER_GMAIL_CONCURRENCY).toBe(3);
    const got = await Promise.all([1, 2, 3, 4].map(() => viewerGmailSlots.acquire("mb-test", 0)));
    expect(got.filter((r) => r !== null)).toHaveLength(3);
    for (const r of got) r?.();
    expect(viewerGmailSlots.inFlight("mb-test")).toBe(0);
  });
});

describe("image allowances", () => {
  const MB = 1024 * 1024;

  it("every image gets the whole per-image 15 MB, up to 60 images; the email's 40 MB is held on served bytes", async () => {
    const { viewImageAllowances, EMAIL_BUDGET_BYTES, MAX_IMAGE_TOKENS } = await import("@/server/view-source");
    const { IMAGE_TOKEN_MAX_BYTES } = await import("@edf/crypto");
    expect(IMAGE_TOKEN_MAX_BYTES).toBe(15 * MB);
    expect(EMAIL_BUDGET_BYTES).toBe(40 * MB);
    expect(MAX_IMAGE_TOKENS).toBe(60);
    expect(viewImageAllowances([])).toEqual([]);
    // Declared sizes no longer matter: a 24 px icon and a 600 px hero alike, so no guess starves
    // a big picture (Canva's 3.9 MB GIF got 2.9 MB of a shared 15 MB beside 20–270 KB PNGs).
    const hints = [
      { width: "24", height: "24" },
      { width: "600", style: "width:600px;height:auto" },
      {},
      { style: "background-image:url(https://img.example.com/bg.jpg)" },
    ];
    expect(viewImageAllowances(hints)).toEqual(Array(4).fill(15 * MB));
    expect(viewImageAllowances(Array.from({ length: 75 }, () => ({})))).toEqual(Array(60).fill(15 * MB));
  });
});

describe.skipIf(!HAS_DB)("buildViewSource: the live Gmail fetch", () => {
  const pool = appPool();
  let userId = "";
  let mailboxId = "";

  beforeAll(async () => {
    gmail.raw = rawEmail(`<html><body><img src="https://img.example.com/hero.png" alt="Hero"><p>Sale</p></body></html>`);
    userId = (await createUser(pool)).id;
    mailboxId = await createMailbox(pool, userId);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function view(emailId: string) {
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    return buildViewSource(signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode: "card" }), emailId);
  }
  const reset = () => Object.assign(gmail, { script: [], calls: 0, inFlight: 0, maxInFlight: 0, reserves: 0, options: [] });

  it("a rate-limited fetch is retried and the view succeeds; each attempt reserved quota", async () => {
    reset();
    gmail.script = [{ kind: "rate_limited", retryAfterMs: 1_000 }];
    const r = await view(await seedEmail(pool, userId, mailboxId));
    expect(r.ok).toBe(true);
    expect(gmail.calls).toBe(2);
    expect(gmail.reserves).toBe(2);
    // One client for the view, with the viewer's per-attempt timeout.
    expect(gmail.options).toHaveLength(1);
    expect(gmail.options[0]).toMatchObject({ timeoutMs: 12_000, maxConcurrent: 1 });
  });

  it("a permanent failure is not retried (and a deleted message is forgotten)", async () => {
    reset();
    gmail.script = [{ kind: "policy" }];
    const r = await view(await seedEmail(pool, userId, mailboxId));
    expect(r).toEqual({ ok: false, status: 503, error: "gmail_policy" });
    expect(gmail.calls).toBe(1);
    reset();
    gmail.script = [{ kind: "not_found" }];
    expect(await view(await seedEmail(pool, userId, mailboxId))).toEqual({ ok: false, status: 404, error: "deleted" });
    expect(gmail.calls).toBe(1);
  });

  it("an empty viewer quota refuses the view before any Gmail call", async () => {
    reset();
    const emailId = await seedEmail(pool, userId, mailboxId);
    await withUser(pool, userId, (_db, c) => c.query("UPDATE gmail_quota SET tokens = -100000, updated_at = now() WHERE mailbox_id = $1", [mailboxId]));
    try {
      expect(await view(emailId)).toEqual({ ok: false, status: 429, error: "quota" });
      expect(gmail.calls).toBe(0);
    } finally {
      await withUser(pool, userId, (_db, c) => c.query("UPDATE gmail_quota SET tokens = 5500, updated_at = now() WHERE mailbox_id = $1", [mailboxId]));
    }
  });

  it("one instance keeps at most 3 fetches in flight per mailbox; the rest wait their turn", async () => {
    reset();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    gmail.script = Array.from({ length: 6 }, () => gate);
    const ids = await Promise.all(Array.from({ length: 6 }, () => seedEmail(pool, userId, mailboxId)));
    const views = ids.map((id) => view(id));
    await vi.waitFor(() => expect(gmail.calls).toBe(3));
    await new Promise((r) => setTimeout(r, 50));
    expect(gmail.calls).toBe(3);
    open();
    const results = await Promise.all(views);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(gmail.calls).toBe(6);
    expect(gmail.maxInFlight).toBe(3);
    const { viewerGmailSlots } = await import("@/server/view-source");
    expect(viewerGmailSlots.inFlight(mailboxId)).toBe(0);
  });
});
