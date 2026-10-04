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

describe("card and full-view image allowances", () => {
  const MB = 1024 * 1024;
  const KB = 1024;
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

  it("never signs more than 6 MB per card (its old share, now only a floor), 40 MB per view or 5 MB per image; every image gets its floor, and a full view never less than its card", async () => {
    const { cardImageAllowances, fullViewImageAllowances, CARD_BUDGET_BYTES, EMAIL_BUDGET_BYTES, IMAGE_FLOOR_BYTES, CARD_MAX_IMAGES, MAX_IMAGE_TOKENS } =
      await import("@/server/view-source");
    expect(CARD_BUDGET_BYTES).toBe(6 * MB);
    expect(EMAIL_BUDGET_BYTES).toBe(40 * MB);
    expect(IMAGE_FLOOR_BYTES).toBe(128 * KB);
    expect(CARD_MAX_IMAGES).toBe(20);
    expect(MAX_IMAGE_TOKENS).toBe(60);
    expect(cardImageAllowances([])).toEqual([]);
    expect(fullViewImageAllowances([])).toEqual([]);
    // Deterministic pseudo-random emails: sizes from avatars to tall heroes, some unsized.
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const sizes = ["", "1", "24", "96", "196", "300", "600", "640", "1200", "100%"];
    for (let k = 0; k < 400; k++) {
      const n = 1 + Math.floor(rnd() * (MAX_IMAGE_TOKENS + 5));
      const hints = Array.from({ length: n }, () => ({
        width: sizes[Math.floor(rnd() * sizes.length)] || null,
        height: sizes[Math.floor(rnd() * sizes.length)] || null,
        style: rnd() < 0.2 ? "width:600px;height:auto" : null,
      }));
      const a = cardImageAllowances(hints);
      const f = fullViewImageAllowances(hints);
      expect(a).toHaveLength(Math.min(n, CARD_MAX_IMAGES));
      expect(f).toHaveLength(Math.min(n, MAX_IMAGE_TOKENS));
      expect(sum(a), `case ${k}`).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
      expect(sum(f), `case ${k}`).toBeLessThanOrEqual(EMAIL_BUDGET_BYTES);
      // Only the rounding is left over (unless every image is at its 5 MB cap).
      if (a.length > 1) expect(sum(a), `case ${k}`).toBeGreaterThan(CARD_BUDGET_BYTES - 1024);
      expect(sum(f), `case ${k}`).toBeGreaterThan(Math.min(EMAIL_BUDGET_BYTES, f.length * 5 * MB) - 1024);
      for (const [i, x] of a.entries()) {
        expect(Number.isSafeInteger(x)).toBe(true);
        expect(x).toBeLessThanOrEqual(5 * MB);
        expect(x).toBeGreaterThanOrEqual(Math.min(128 * KB, Math.floor((1.5 * MB) / a.length)));
        // Opening the email never gives an image less than its card did.
        expect(f[i], `case ${k} image ${i}`).toBeGreaterThanOrEqual(x);
      }
      for (const x of f) {
        expect(Number.isSafeInteger(x)).toBe(true);
        expect(x).toBeLessThanOrEqual(5 * MB);
        expect(x).toBeGreaterThanOrEqual(Math.min(128 * KB, Math.floor((3.75 * MB) / f.length)));
      }
    }
  });

  it("gives a lone hero the full view's 5 MB, and a large hero most of the budget beside small images", async () => {
    const { cardImageAllowances } = await import("@/server/view-source");
    // A one-picture mailer (its 3–5 MB PNG was a grey box at 1 MB per card image).
    expect(cardImageAllowances([{ width: "500", height: "500" }])).toEqual([5 * MB]);
    // Logo first, then the hero, then four 100 px images: the hero's place doesn't matter.
    const logo = { width: "150", height: "40" };
    const hero = { width: "600", height: "600" };
    const few = cardImageAllowances([logo, hero, ...Array.from({ length: 4 }, () => ({ width: "100", height: "100" }))]);
    expect(few[1]).toBeGreaterThan(4.7 * MB);
    for (const i of [0, 2, 3, 4, 5]) expect(few[i]).toBeGreaterThanOrEqual(200 * KB);
    // Beside a logo and 18 icons (20 images: 75 KB floors), still ≈ 4.4 MB.
    const many = cardImageAllowances([logo, hero, ...Array.from({ length: 18 }, () => ({ width: "24", height: "24" }))]);
    expect(many[1]).toBeGreaterThan(4.3 * MB);
    for (const i of [0, ...Array.from({ length: 18 }, (_, j) => j + 2)]) expect(many[i]).toBeGreaterThanOrEqual(75 * KB);
  });

  it("shares alike images by slot: the first four the most, then less the later they come (a card shows the top)", async () => {
    const { cardImageAllowances, cardSlotWeight } = await import("@/server/view-source");
    expect([0, 3, 4, 7, 19].map(cardSlotWeight)).toEqual([1, 1, 0.8 ** 1.25, 0.5 ** 1.25, 0.2 ** 1.25]);
    const six = cardImageAllowances(Array.from({ length: 6 }, () => ({})));
    expect(new Set(six.slice(0, 4)).size).toBe(1);
    expect(six[0]).toBeGreaterThan(1.05 * MB); // more than the old 1 MB for the first four
    expect(six[3]!).toBeGreaterThan(six[4]!);
    expect(six[4]!).toBeGreaterThan(six[5]!);
    expect(six[5]).toBeGreaterThan(700 * KB);
    const twenty = cardImageAllowances(Array.from({ length: 20 }, () => ({ width: "196", height: "196" })));
    expect(new Set(twenty.slice(0, 4)).size).toBe(1);
    expect(twenty[0]).toBeGreaterThan(500 * KB);
    for (let i = 4; i < 20; i++) expect(twenty[i]!).toBeLessThan(twenty[i - 1]!);
    expect(twenty[19]).toBeGreaterThanOrEqual(140 * KB);
  });

  it("gives a hero declared by its width alone more than the same-width images below it (Chanty)", async () => {
    const { cardImageAllowances } = await import("@/server/view-source");
    // The 2026-10-01 audit's Chanty cards, with the hints edf-app sees: a CSS background on a
    // 600 px wrapper, then every picture declared by its width only (a 600 × 89 header, a 600 × 306
    // banner, the 836,540-byte 600 × 538 hero, …), then three 32 px social icons. Weighed by size
    // alone the hero got 593–608 KB and failed; it loaded under the old 1 MB for the first four.
    const bg = { style: "background:#FFFFFF url(https://img.example.com/bg.jpeg)center center/cover no-repeat;margin:0px auto;max-width:600px" };
    const st = "display:block;outline:none;text-decoration:none;height:auto;font-size:13px;width:100%";
    const w = (width: string) => ({ width, style: st });
    const icons = Array.from({ length: 3 }, () => ({ width: "32", style: "width:32px" }));
    const a = cardImageAllowances([bg, w("600"), w("600"), w("600"), w("600"), ...Array.from({ length: 6 }, () => w("450")), w("600"), ...icons]);
    expect(a[3]).toBeGreaterThanOrEqual(836_540);
    const b = cardImageAllowances([bg, ...Array.from({ length: 8 }, () => w("600")), ...icons]);
    expect(b[3]).toBeGreaterThanOrEqual(799_458);
  });

  it("lets two or three large GIFs share most of the budget while the small images keep a usable share", async () => {
    const { cardImageAllowances } = await import("@/server/view-source");
    const big = { width: "600", height: "600" };
    const small = { width: "40", height: "40" };
    const a = cardImageAllowances([small, big, small, big, small, big, ...Array.from({ length: 8 }, () => small)]);
    for (const i of [1, 3]) expect(a[i]).toBeGreaterThan(1.8 * MB);
    expect(a[5]).toBeGreaterThan(1.1 * MB);
    for (const i of [0, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13]) expect(a[i]).toBeGreaterThanOrEqual(107 * KB);
    expect(sum(a)).toBeLessThanOrEqual(6 * MB);
  });

  it("a view gives up to eight images 5 MB, n alike images 40 MB ÷ n, and a hero at least what the old card share gave it", async () => {
    const { cardImageAllowances, fullViewImageAllowances } = await import("@/server/view-source");
    const alike = (n: number) => Array.from({ length: n }, () => ({}));
    for (const n of [1, 2, 3, 8]) expect(fullViewImageAllowances(alike(n))).toEqual(Array(n).fill(5 * MB));
    for (const n of [9, 20]) expect(fullViewImageAllowances(alike(n)), `${n}`).toEqual(Array(n).fill(Math.floor((40 * MB) / n)));
    // Canva's card (2026-10-01 audit): a 2 MB GIF hero beside a logo and a dozen small images.
    // The card gave it ≈ 4.6 MB; an even 15 MB ÷ 13 split gave it 1.18 MB, so it showed in the
    // card and "Picture unavailable" in the opened email.
    const logo = { width: "150", height: "40" };
    const hero = { width: "600", height: "600" };
    const hints = [logo, hero, ...Array.from({ length: 11 }, () => ({ width: "24", height: "24" }))];
    const card = cardImageAllowances(hints);
    const full = fullViewImageAllowances(hints);
    expect(card[1]).toBeGreaterThan(4.4 * MB);
    expect(full[1]).toBe(5 * MB);
    for (const [i, x] of card.entries()) expect(full[i]).toBeGreaterThanOrEqual(x);
    // Past 20 images, alike images still get a usable share (≈ 680 KB at 60).
    const sixty = fullViewImageAllowances(alike(60));
    expect(sum(sixty)).toBeLessThanOrEqual(40 * MB);
    for (const x of sixty.slice(20)) expect(x).toBeGreaterThan(600 * KB);
  });

  it("weighs an image by its declared display size", async () => {
    const { imageDisplayArea } = await import("@/server/view-source");
    expect(imageDisplayArea({ width: "600", height: "300" })).toBe(600 * 300);
    expect(imageDisplayArea({ width: "600px", height: " 300 " })).toBe(600 * 300);
    // Style when there are no attributes (the last declaration wins), max-width/height after that.
    expect(imageDisplayArea({ style: "display:block;width:300px;height:200px;width:400px" })).toBe(400 * 200);
    expect(imageDisplayArea({ style: "max-width:600px !important;height:auto" })).toBe(600 * 450);
    // A missing height is ¾ of the width (and the reverse); a percentage is of a 600 px column.
    expect(imageDisplayArea({ width: "600" })).toBe(600 * 450);
    expect(imageDisplayArea({ height: "300" })).toBe(400 * 300);
    expect(imageDisplayArea({ width: "100%", height: "200" })).toBe(600 * 200);
    // Wider than the 800 px layout: scaled down to it.
    expect(imageDisplayArea({ width: "1600", height: "800" })).toBe(800 * 400);
    // Unknown (unsized, a CSS background, nonsense, zero): 150 × 150.
    for (const h of [{}, { width: "auto" }, { width: "0", height: "0" }, { style: "width:calc(100% - 2px)" }])
      expect(imageDisplayArea(h), JSON.stringify(h)).toBe(150 * 150);
    // Clamped to [16², 800 × 1600].
    expect(imageDisplayArea({ width: "2", height: "2" })).toBe(16 * 16);
    expect(imageDisplayArea({ width: "600", height: "9000" })).toBe(800 * 1600);
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
