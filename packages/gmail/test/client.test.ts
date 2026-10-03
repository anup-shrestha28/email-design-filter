import { describe, expect, it } from "vitest";
import {
  classifyGmailFailure,
  decodeRawMessage,
  GmailClient,
  GmailError,
  parseRetryAfter,
  rateLimitBackoffMs,
  UNITS,
  type GetAccessToken,
} from "../src/index";
import { fakeFetch, googleError, json, streamingJson } from "./fake-http";

function tokens(
  ...list: string[]
): GetAccessToken & { calls: Array<{ rejectedToken?: string } | undefined> } {
  const calls: Array<{ rejectedToken?: string } | undefined> = [];
  let i = 0;
  const f: GetAccessToken = async (opts) => {
    calls.push(opts);
    const t = list[Math.min(i, list.length - 1)] as string;
    i++;
    return t;
  };
  return Object.assign(f, { calls });
}

const BIG_HISTORY_ID = "18446744073709551000"; // > 2^53: must survive as a string

describe("GmailClient", () => {
  it("exports the 2026 unit costs", () => {
    expect(UNITS).toMatchObject({
      getProfile: 1,
      historyList: 2,
      messagesList: 5,
      messagesGet: 20,
      attachmentsGet: 20,
    });
  });

  it("getProfile: bearer token, no redirects, validated response", async () => {
    const f = fakeFetch(() =>
      json({ emailAddress: "a@example.com", historyId: BIG_HISTORY_ID, messagesTotal: 3 }),
    );
    const c = new GmailClient({ getAccessToken: tokens("tok-1"), fetch: f });
    const p = await c.getProfile();
    expect(p).toEqual({
      emailAddress: "a@example.com",
      historyId: BIG_HISTORY_ID,
      messagesTotal: 3,
    });
    expect(f.calls[0]?.url.href).toBe("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    expect(f.calls[0]?.headers.get("authorization")).toBe("Bearer tok-1");
    expect(f.calls[0]?.redirect).toBe("error");
  });

  it("historyList: sends uint64 cursor as-is, maxResults=500 and all four history types", async () => {
    const f = fakeFetch(() =>
      json({ historyId: BIG_HISTORY_ID, history: [{ id: BIG_HISTORY_ID }] }),
    );
    const c = new GmailClient({ getAccessToken: tokens("t"), fetch: f });
    const r = await c.historyList({ startHistoryId: "9007199254740993", pageToken: "pt" });
    const q = f.calls[0]?.url.searchParams;
    expect(q?.get("startHistoryId")).toBe("9007199254740993");
    expect(q?.get("maxResults")).toBe("500");
    expect(q?.getAll("historyTypes")).toEqual([
      "messageAdded",
      "messageDeleted",
      "labelAdded",
      "labelRemoved",
    ]);
    expect(q?.get("pageToken")).toBe("pt");
    expect(r.historyId).toBe(BIG_HISTORY_ID);
    await expect(c.historyList({ startHistoryId: "12e3" })).rejects.toThrow(TypeError);
  });

  it("retries exactly once on 401 with a forced refresh (rejectedToken)", async () => {
    const f = fakeFetch((req) =>
      req.headers.get("authorization") === "Bearer fresh"
        ? json({ emailAddress: "a@b.co", historyId: "5" })
        : new Response("", { status: 401 }),
    );
    const t = tokens("stale", "fresh");
    const c = new GmailClient({ getAccessToken: t, fetch: f });
    await expect(c.getProfile()).resolves.toMatchObject({ historyId: "5" });
    expect(f.calls).toHaveLength(2);
    expect(t.calls).toEqual([undefined, { rejectedToken: "stale" }]);

    const f2 = fakeFetch(() => new Response("", { status: 401 }));
    const c2 = new GmailClient({ getAccessToken: tokens("a", "b"), fetch: f2 });
    const err = await c2.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GmailError);
    expect((err as GmailError).kind).toBe("unauthorized");
    expect(f2.calls).toHaveLength(2); // one retry only
  });

  it("maps vendor errors to kinds, without leaking bodies", async () => {
    const cases: Array<[Response, string, string?]> = [
      [googleError(403, "userRateLimitExceeded"), "rate_limited"],
      [googleError(403, "rateLimitExceeded"), "rate_limited"],
      [googleError(429, "rateLimitExceeded"), "rate_limited"],
      [googleError(403, "dailyLimitExceeded"), "daily_limit"],
      [googleError(403, "domainPolicy"), "policy"],
      [googleError(403, "insufficientPermissions"), "policy"],
      [googleError(400, "failedPrecondition"), "policy"],
      [googleError(400, "invalidArgument"), "bad_request"],
      [googleError(500, "backendError"), "server"],
      [googleError(503, "backendError"), "server"],
      [new Response("<html>oops</html>", { status: 502 }), "server"],
    ];
    for (const [res, kind] of cases) {
      const c = new GmailClient({
        getAccessToken: tokens("t"),
        fetch: fakeFetch(() => res.clone()),
      });
      const err = (await c.getProfile().catch((e: unknown) => e)) as GmailError;
      expect(err).toBeInstanceOf(GmailError);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain("secret-body-text");
      expect(err.message).not.toContain("user@example.com");
    }
  });

  it("404 is not_found for messages and history_expired for history", async () => {
    const f = fakeFetch(() => googleError(404, "notFound"));
    const c = new GmailClient({ getAccessToken: tokens("t"), fetch: f });
    await expect(c.messagesGet("abc", { format: "minimal" })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(c.historyList({ startHistoryId: "1" })).rejects.toMatchObject({
      kind: "history_expired",
    });
  });

  it("rate limits carry retryAfterMs from Retry-After, else 1s→64s backoff with jitter", async () => {
    const withHeader = fakeFetch(() => json({ error: { code: 429 } }, 429, { "retry-after": "7" }));
    const c1 = new GmailClient({ getAccessToken: tokens("t"), fetch: withHeader });
    await expect(c1.getProfile()).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 7000,
    });

    const noHeader = fakeFetch(() => googleError(403, "userRateLimitExceeded"));
    const c2 = new GmailClient({ getAccessToken: tokens("t"), fetch: noHeader, random: () => 0.5 });
    await expect(c2.getProfile()).rejects.toMatchObject({ retryAfterMs: 1500 });
    await expect(c2.getProfile()).rejects.toMatchObject({ retryAfterMs: 2500 });
    expect(rateLimitBackoffMs(7, () => 0)).toBe(64_000);
    expect(rateLimitBackoffMs(50, () => 0.999)).toBe(64_999);
    expect(
      parseRetryAfter("Wed, 21 Oct 2015 07:28:30 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT")),
    ).toBe(30_000);
    expect(parseRetryAfter("0", 0)).toBe(1000);
    expect(parseRetryAfter("junk", 0)).toBeNull();
  });

  it("classifies project-level refusals as daily_limit (global pause)", () => {
    expect(classifyGmailFailure(403, "accessNotConfigured", null, "not_found")).toBe("daily_limit");
    expect(classifyGmailFailure(400, null, "FAILED_PRECONDITION", "not_found")).toBe("policy");
    expect(classifyGmailFailure(403, null, null, "not_found")).toBe("policy");
    expect(classifyGmailFailure(418, null, null, "not_found")).toBe("bad_response");
  });

  it("network failures and timeouts are `network`", async () => {
    const c = new GmailClient({
      getAccessToken: tokens("t"),
      fetch: fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(c.getProfile()).rejects.toMatchObject({ kind: "network", retriable: true });
  });

  it("enforces the byte cap while streaming (too_large) and via content-length", async () => {
    const c = new GmailClient({
      getAccessToken: tokens("t"),
      fetch: fakeFetch(() => streamingJson(300_000)),
    });
    await expect(c.messagesGet("abc", { format: "raw", maxBytes: 100_000 })).rejects.toMatchObject({
      kind: "too_large",
    });

    const declared = new Response("{}", {
      status: 200,
      headers: { "content-length": "999999999" },
    });
    const c2 = new GmailClient({ getAccessToken: tokens("t"), fetch: fakeFetch(() => declared) });
    await expect(c2.messagesGet("abc", { format: "raw", maxBytes: 1000 })).rejects.toMatchObject({
      kind: "too_large",
    });
  });

  it("rejects responses that fail validation (untrusted input)", async () => {
    const bad = [
      json({ emailAddress: "a@b.co", historyId: 12345 }), // number, not a uint64 string
      json({ emailAddress: "a@b.co" }),
      new Response("not json", { status: 200 }),
    ];
    for (const res of bad) {
      const c = new GmailClient({
        getAccessToken: tokens("t"),
        fetch: fakeFetch(() => res.clone()),
      });
      await expect(c.getProfile()).rejects.toMatchObject({ kind: "bad_response" });
    }
    const hostileId = json({ messages: [{ id: "../../etc" }] });
    const c = new GmailClient({ getAccessToken: tokens("t"), fetch: fakeFetch(() => hostileId) });
    await expect(c.messagesList({ q: "x" })).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("never runs more than 4 requests at once per client", async () => {
    let active = 0;
    let peak = 0;
    const f = fakeFetch(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return json({ emailAddress: "a@b.co", historyId: "1" });
    });
    const c = new GmailClient({ getAccessToken: tokens("t"), fetch: f, maxConcurrent: 16 });
    await Promise.all(Array.from({ length: 12 }, () => c.getProfile()));
    expect(peak).toBe(4);
    expect(f.calls).toHaveLength(12);
  });

  it("messagesList / messagesGet / attachmentsGet build the documented requests", async () => {
    const raw = Buffer.from("Subject: hi\r\n\r\nbody").toString("base64url");
    const f = fakeFetch((req) => {
      if (req.url.pathname.endsWith("/messages"))
        return json({ messages: [{ id: "a1", threadId: "t1" }], nextPageToken: "n" });
      if (req.url.pathname.includes("/attachments/"))
        return json({ size: 5, data: Buffer.from("<b>x</b>").toString("base64url") });
      return json({ id: "a1", historyId: "77", internalDate: "1700000000000", raw });
    });
    const c = new GmailClient({ getAccessToken: tokens("t"), fetch: f });
    const list = await c.messagesList({
      q: "after:1",
      includeSpamTrash: true,
      labelIds: ["INBOX"],
    });
    expect(list.nextPageToken).toBe("n");
    expect(f.calls[0]?.url.searchParams.get("includeSpamTrash")).toBe("true");
    expect(f.calls[0]?.url.searchParams.get("maxResults")).toBe("500");

    const msg = await c.messagesGet("a1", { format: "raw", fields: "id,raw" });
    expect(f.calls[1]?.url.searchParams.get("format")).toBe("raw");
    expect(f.calls[1]?.url.searchParams.get("fields")).toBe("id,raw");
    expect(Buffer.from(decodeRawMessage(msg)).toString()).toContain("Subject: hi");

    const att = await c.attachmentsGet("a1", "ANGjdJ_x-1", { maxBytes: 1024 });
    expect(Buffer.from(att).toString()).toBe("<b>x</b>");
    await expect(c.attachmentsGet("a1", "ANGjdJ_x-1", { maxBytes: 3 })).rejects.toMatchObject({
      kind: "too_large",
    });
    await expect(c.messagesGet("a/../b", { format: "raw" })).rejects.toThrow(TypeError);
  });
});
