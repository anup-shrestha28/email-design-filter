import { describe, expect, it } from "vitest";
import {
  applyLabelDelta,
  GmailError,
  labelFlags,
  pollHistory,
  type HistoryListParams,
  type HistoryListResponse,
  type HistoryRecord,
} from "../src/index";

/**
 * A fake Gmail history log. Pages hold `pageSize` records; the top-level `historyId` is always
 * the mailbox's *current* id (as Gmail does), and a listing can optionally be pinned to the
 * snapshot taken at its first page (records added mid-paging are invisible to it).
 */
class FakeHistory {
  records: HistoryRecord[] = [];
  current = 0n;
  calls: HistoryListParams[] = [];
  constructor(
    private readonly pageSize: number,
    private readonly pinned = false,
    start = 1000n,
  ) {
    this.current = start;
  }
  add(rec: Omit<HistoryRecord, "id">, id?: bigint): string {
    this.current = id ?? this.current + 1n;
    const full = { id: this.current.toString(), ...rec };
    this.records.push(full);
    return full.id;
  }
  bump(by: bigint): void {
    this.current += by; // changes Gmail doesn't report for our history types
  }
  private snapshots = new Map<string, HistoryRecord[]>();
  async historyList(p: HistoryListParams): Promise<HistoryListResponse> {
    this.calls.push(p);
    const start = BigInt(p.startHistoryId);
    if (start < 100n)
      throw new GmailError("history_expired", { method: "users.history.list", status: 404 });
    let list: HistoryRecord[];
    let offset = 0;
    if (p.pageToken) {
      const [key, off] = p.pageToken.split(":");
      list = this.snapshots.get(key as string) ?? [];
      offset = Number(off);
    } else {
      list = this.records.filter((r) => BigInt(r.id) > start);
    }
    if (!this.pinned && p.pageToken) list = this.records.filter((r) => BigInt(r.id) > start);
    const key = `${p.startHistoryId}-${this.calls.length}`;
    const page = list.slice(offset, offset + this.pageSize);
    const more = offset + this.pageSize < list.length;
    if (more) this.snapshots.set(key, list);
    const res: HistoryListResponse = { historyId: this.current.toString() };
    if (page.length) res.history = page;
    if (more) res.nextPageToken = `${key}:${offset + this.pageSize}`;
    return res;
  }
}

const added = (id: string, labelIds?: string[]) => ({
  messagesAdded: [{ message: { id, threadId: `t${id}`, ...(labelIds ? { labelIds } : {}) } }],
});
const far = () => Date.now() + 60_000;

describe("pollHistory — cursor rule (FREE-TIER §4.2 step 5)", () => {
  it("3 pages with a 2-page cap lose no message ids across two polls", async () => {
    const g = new FakeHistory(2);
    const ids = ["m1", "m2", "m3", "m4", "m5", "m6"];
    for (const id of ids) g.add(added(id, ["INBOX", "CATEGORY_PROMOTIONS"]));
    g.bump(50n); // the mailbox's current id is well past the last record
    const start = "1000";

    const first = await pollHistory(g, { startHistoryId: start, maxPages: 2, deadlineMs: far() });
    expect(first.complete).toBe(false);
    expect(first.pages).toBe(2);
    // Last record processed (the 4th), never the top-level historyId (1056).
    expect(first.newCursor).toBe("1004");
    expect(first.newCursor).not.toBe(g.current.toString());
    expect(first.records.map((r) => r.messageId)).toEqual(["m1", "m2", "m3", "m4"]);

    const second = await pollHistory(g, {
      startHistoryId: first.newCursor,
      maxPages: 2,
      deadlineMs: far(),
    });
    expect(second.complete).toBe(true);
    expect(second.newCursor).toBe(g.current.toString());
    const seen = new Set(
      [...first.records, ...second.records]
        .filter((r) => r.action === "insert")
        .map((r) => r.messageId),
    );
    expect([...seen].sort()).toEqual(ids);
  });

  it("keeps uint64 cursors exact beyond 2^53 (never parsed to Number)", async () => {
    const base = 18446744073709550000n; // near uint64 max
    const g = new FakeHistory(1, false, base);
    g.add(added("a"));
    g.add(added("b"));
    const r1 = await pollHistory(g, {
      startHistoryId: base.toString(),
      maxPages: 1,
      deadlineMs: far(),
    });
    expect(r1.newCursor).toBe("18446744073709550001");
    expect(Number(r1.newCursor).toString()).not.toBe(r1.newCursor); // a Number round-trip would corrupt it
    const r2 = await pollHistory(g, {
      startHistoryId: r1.newCursor,
      maxPages: 5,
      deadlineMs: far(),
    });
    expect(r2.complete).toBe(true);
    expect(r2.newCursor).toBe("18446744073709550002");
    expect(r2.records.map((r) => r.historyId)).toEqual(["18446744073709550002"]);
    await expect(
      pollHistory(g, { startHistoryId: "18446744073709551616", maxPages: 1, deadlineMs: far() }),
    ).rejects.toThrow(TypeError);
  });

  it("multi-page complete poll uses the first page's historyId, so mail added mid-paging isn't skipped", async () => {
    const g = new FakeHistory(2, true);
    for (const id of ["a", "b", "c"]) g.add(added(id));
    const realList = g.historyList.bind(g);
    let n = 0;
    g.historyList = async (p) => {
      const res = await realList(p);
      if (++n === 1) g.add(added("late")); // arrives after the first page; the pinned listing won't show it
      return res;
    };
    const r = await pollHistory(g, { startHistoryId: "1000", maxPages: 10, deadlineMs: far() });
    expect(r.complete).toBe(true);
    expect(r.records.map((x) => x.messageId)).toEqual(["a", "b", "c"]);
    expect(r.newCursor).toBe("1003"); // first page's historyId, not the final current id 1004
    g.historyList = realList;
    const next = await pollHistory(g, {
      startHistoryId: r.newCursor,
      maxPages: 10,
      deadlineMs: far(),
    });
    expect(next.records.map((x) => x.messageId)).toEqual(["late"]);
  });

  it("stops at the deadline and resumes from the last processed record", async () => {
    const g = new FakeHistory(1);
    for (const id of ["a", "b", "c"]) g.add(added(id));
    let t = 0;
    const r = await pollHistory(g, {
      startHistoryId: "1000",
      maxPages: 100,
      deadlineMs: 0,
      now: () => t++,
    });
    expect(r.complete).toBe(false);
    expect(r.pages).toBe(1);
    expect(r.newCursor).toBe("1001");
  });

  it("an empty first page with a nextPageToken never pins the cursor", async () => {
    const g = new FakeHistory(1);
    g.add(added("a"));
    const realList = g.historyList.bind(g);
    let first = true;
    g.historyList = async (p) => {
      if (first) {
        first = false;
        return { historyId: "2000", nextPageToken: "1000-x:0" };
      }
      return realList({ ...p, pageToken: undefined });
    };
    const r = await pollHistory(g, { startHistoryId: "1000", maxPages: 1, deadlineMs: far() });
    expect(r.pages).toBe(2);
    expect(r.records.map((x) => x.messageId)).toEqual(["a"]);
  });

  it("never advances the cursor below the start or past unprocessed records when truncated with no records", async () => {
    const g = new FakeHistory(1);
    g.add(added("a"));
    g.historyList = async () => ({ historyId: "5000", nextPageToken: "tok" });
    const r = await pollHistory(g, {
      startHistoryId: "1000",
      maxPages: 1,
      deadlineMs: 0,
      now: () => 1,
    });
    expect(r.complete).toBe(false);
    expect(r.newCursor).toBe("1000");
  });

  it("refuses to truncate when records arrive out of order", async () => {
    const pages: HistoryListResponse[] = [
      { historyId: "9000", history: [{ id: "1005" }, { id: "1003" }], nextPageToken: "p2" },
      { historyId: "9000", history: [{ id: "1004" }] },
    ];
    let i = 0;
    const client = { historyList: async () => pages[i++] as HistoryListResponse };
    await expect(
      pollHistory(client, { startHistoryId: "1000", maxPages: 1, deadlineMs: far() }),
    ).rejects.toMatchObject({
      kind: "bad_response",
    });
    i = 0; // complete listings are fine in any order
    const ok = await pollHistory(client, {
      startHistoryId: "1000",
      maxPages: 5,
      deadlineMs: far(),
    });
    expect(ok.complete).toBe(true);
  });

  it("propagates history_expired (404) for the resync path", async () => {
    const g = new FakeHistory(10);
    await expect(
      pollHistory(g, { startHistoryId: "5", maxPages: 2, deadlineMs: far() }),
    ).rejects.toMatchObject({
      kind: "history_expired",
    });
  });
});

describe("pollHistory — merging and pre-filtering", () => {
  it("merges changes per message id in order and pre-filters DRAFT/SENT/CHAT/SPAM", async () => {
    const g = new FakeHistory(100);
    g.add(added("new", ["INBOX", "UNREAD", "CATEGORY_UPDATES"]));
    g.add({ labelsRemoved: [{ message: { id: "new" }, labelIds: ["UNREAD"] }] });
    g.add(added("draft", ["DRAFT"]));
    g.add(added("sent", ["SENT", "INBOX"]));
    g.add(added("chat", ["CHAT"]));
    g.add(added("spam", ["SPAM"]));
    g.add(added("nolabels"));
    g.add(added("gone", ["INBOX"]));
    g.add({ messagesDeleted: [{ message: { id: "gone" } }] });
    g.add({ labelsAdded: [{ message: { id: "known" }, labelIds: ["STARRED", "UNREAD"] }] });
    g.add({ labelsRemoved: [{ message: { id: "known" }, labelIds: ["UNREAD"] }] });
    g.add({ labelsAdded: [{ message: { id: "tospam" }, labelIds: ["SPAM"] }] });
    g.add({ labelsRemoved: [{ message: { id: "unspam" }, labelIds: ["SPAM"] }] });
    g.add({ labelsAdded: [{ message: { id: "respam" }, labelIds: ["SPAM"] }] }, 1100n);
    g.add({ labelsRemoved: [{ message: { id: "respam" }, labelIds: ["SPAM"] }] });
    g.add({ labelsAdded: [{ message: { id: "respam" }, labelIds: ["SPAM"] }] });

    const r = await pollHistory(g, { startHistoryId: "1000", maxPages: 1, deadlineMs: far() });
    const by = new Map(r.records.map((x) => [x.messageId, x]));
    expect(r.records.map((x) => x.messageId)).toEqual([
      "new",
      "draft",
      "sent",
      "chat",
      "spam",
      "nolabels",
      "gone",
      "known",
      "tospam",
      "unspam",
      "respam",
    ]);
    expect(by.get("new")).toMatchObject({
      action: "insert",
      added: true,
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
      historyId: "1002",
    });
    expect(by.get("draft")).toMatchObject({ action: "skip", skipReason: "draft" });
    expect(by.get("sent")).toMatchObject({ action: "skip", skipReason: "sent" });
    expect(by.get("chat")).toMatchObject({ action: "skip", skipReason: "chat" });
    expect(by.get("spam")).toMatchObject({ action: "skip", skipReason: "spam" });
    expect(by.get("nolabels")).toMatchObject({ action: "insert", labelIds: null });
    expect(by.get("gone")).toMatchObject({ action: "delete" });
    expect(by.get("known")).toMatchObject({
      action: "labels",
      labelsAdded: ["STARRED"],
      labelsRemoved: ["UNREAD"],
      refetch: false,
    });
    expect(by.get("tospam")).toMatchObject({
      action: "labels",
      labelsAdded: ["SPAM"],
      refetch: false,
    });
    expect(by.get("unspam")).toMatchObject({
      action: "labels",
      labelsRemoved: ["SPAM"],
      refetch: true,
    });
    expect(by.get("respam")).toMatchObject({
      labelsAdded: ["SPAM"],
      labelsRemoved: [],
      refetch: false,
      historyId: "1102",
    });
    expect(r.addedCount).toBe(7);
    expect(r.importStorm).toBe(false);
    expect(r.complete).toBe(true);
  });

  it("a message added as SPAM and un-spammed in the same poll is inserted", async () => {
    const g = new FakeHistory(10);
    g.add(added("x", ["SPAM", "UNREAD"]));
    g.add({ labelsRemoved: [{ message: { id: "x" }, labelIds: ["SPAM"] }] });
    const r = await pollHistory(g, { startHistoryId: "1000", maxPages: 1, deadlineMs: far() });
    expect(r.records[0]).toMatchObject({ action: "insert", labelIds: ["UNREAD"], refetch: false });
  });

  it("flags an import storm above 2,000 messagesAdded", async () => {
    const g = new FakeHistory(500);
    for (let i = 0; i < 2001; i++) g.add(added(`m${i}`, ["INBOX"]));
    const r = await pollHistory(g, { startHistoryId: "1000", maxPages: 10, deadlineMs: far() });
    expect(r.addedCount).toBe(2001);
    expect(r.importStorm).toBe(true);
    expect(r.pages).toBe(5);
  });
});

describe("labels", () => {
  it("labelFlags maps system labels to email flags", () => {
    expect(labelFlags(["UNREAD", "STARRED", "IMPORTANT", "CATEGORY_SOCIAL", "INBOX"])).toEqual({
      isUnread: true,
      isStarred: true,
      gmailImportant: true,
      inTrash: false,
      inSpam: false,
      gmailCategory: "social",
      isDraft: false,
      isSent: false,
      isChat: false,
    });
    expect(labelFlags(["TRASH", "SPAM", "DRAFT", "SENT", "CHAT"])).toMatchObject({
      inTrash: true,
      inSpam: true,
      isDraft: true,
      isSent: true,
      isChat: true,
      gmailCategory: null,
      isUnread: false,
    });
    expect(labelFlags(["CATEGORY_PERSONAL"]).gmailCategory).toBe("personal");
  });

  it("applyLabelDelta removes, adds, dedupes and preserves order", () => {
    expect(applyLabelDelta(["INBOX", "UNREAD", "INBOX"], ["STARRED", "INBOX"], ["UNREAD"])).toEqual(
      ["INBOX", "STARRED"],
    );
    expect(applyLabelDelta([], ["A"], ["A"])).toEqual(["A"]);
  });
});
