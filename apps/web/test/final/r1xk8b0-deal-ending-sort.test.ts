/**
 * R1-35: "Deal ending soonest" must not lead with deals that ended long ago. Expired deals are left
 * out (the Active deal filter's rule); live deals come soonest first, undated deals last, and keyset
 * paging still returns every remaining row exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type * as InboxQueries from "@/server/queries/inbox";
import { DEFAULT_FILTERS } from "@/lib/filters";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

type Deal = EmailRecord["deals"][number];
const HOUR = 3_600_000;
const deal = (endsAt: Date | null): Deal => ({
  kind: "percent_off", value: 20, currency: null, isUpTo: false, minSpend: null, code: null, startsAt: null,
  endsAt, endsAtConfidence: 0.9, source: "regex",
});

describe.skipIf(!HAS_DB)("deal ending soonest sort", () => {
  let app: pg.Pool;
  let user: string;
  let inbox: typeof InboxQueries;
  const id: Record<string, string> = {};

  beforeAll(async () => {
    app = appPool();
    inbox = await import("@/server/queries/inbox");
    user = (await createUser(app, { role: "owner" })).id;
    const mb = await createMailbox(app, user);
    const now = Date.now();
    const seed = async (key: string, ageH: number, deals: Deal[]) => {
      id[key] = await seedEmail(app, user, mb, { receivedAt: new Date(now - ageH * HOUR), deals });
    };
    await seed("augustSale", 60 * 24, [deal(new Date(now - 40 * 24 * HOUR))]);
    await seed("lastWeek", 10 * 24, [deal(new Date(now - 7 * 24 * HOUR))]);
    await seed("endsTomorrow", 2, [deal(new Date(now + 24 * HOUR))]);
    await seed("endsIn5h", 3, [deal(new Date(now + 5 * HOUR))]);
    await seed("endsNextWeek", 4, [deal(new Date(now + 7 * 24 * HOUR))]);
    await seed("undated", 5, [deal(null)]);
    await seed("noDeal", 1, []);
  });
  afterAll(async () => {
    await app.end();
  });

  const keys = (ids: string[]) => ids.map((x) => Object.keys(id).find((k) => id[k] === x) ?? `foreign:${x}`);

  it("lists live deals soonest first, undated last, and leaves out deals that already ended", async () => {
    const f = { ...DEFAULT_FILTERS, scope: "all" as const, sort: "deal_ending" as const };
    const first = await inbox.listInbox(user, f);
    expect(keys(first.items.map((i) => i.id))).toEqual(["endsIn5h", "endsTomorrow", "endsNextWeek", "undated"]);

    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await inbox.listInbox(user, f, { cursor, limit: 1 });
      paged.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(keys(paged)).toEqual(["endsIn5h", "endsTomorrow", "endsNextWeek", "undated"]);
  });
});
