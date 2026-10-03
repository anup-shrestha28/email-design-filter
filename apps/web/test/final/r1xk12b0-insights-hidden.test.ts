/**
 * Insights leaves hidden mail out of every panel (DATA-MODEL.md §5: user-facing queries use
 * `NOT is_hidden`, where is_hidden = in_trash OR in_spam OR sender_muted). Frequency spikes,
 * best/worst senders and Top issues used to count trashed, spammed and muted-sender mail while the
 * totals and distribution on the same page did not.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";
import { fromSender, senderIdOf } from "../tests-server/helpers";

type User = Awaited<ReturnType<typeof createUser>>;
const HOUR = 3_600_000;

describe.skipIf(!HAS_DB)("Insights excludes hidden mail", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let user: User;
  let visibleSender: string;
  const hiddenSenders: Record<"trash" | "spam" | "muted", string> = { trash: "", spam: "", muted: "" };

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    user = await createUser(app, { role: "friend", name: "Hidden Tester" });
    const mb = await createMailbox(app, user.id, { address: `hid-${randomBytes(3).toString("hex")}@gmail.example` });
    const now = Date.now();
    const scored = (score: number, issue: string) => ({
      designStatus: "done" as const,
      designScore: score,
      designBand: (score >= 85 ? "excellent" : "poor") as "excellent" | "poor",
      designProvisional: false,
      designCapped: false,
      designIssues: [issue] as never,
    });

    // One visible sender: 3 scored emails, spread over 35 days so it never counts as a spike.
    let first = "";
    for (let i = 0; i < 3; i++) {
      const id = await seedEmail(app, user.id, mb, {
        ...fromSender("hello@visible.example", { displayName: "Visible Shop" }),
        receivedAt: new Date(now - (i * 10 + 1) * 24 * HOUR),
        ...scored(90, "contrast"),
      });
      if (i === 0) first = id;
    }
    visibleSender = await senderIdOf(owner, first);

    // Three hidden senders, each with 5 scored, issue-bearing emails in the last 7 days (a spike).
    for (const kind of ["trash", "spam", "muted"] as const) {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push(
          await seedEmail(app, user.id, mb, {
            ...fromSender(`hi@${kind}.example`, { displayName: `Hidden ${kind}` }),
            receivedAt: new Date(now - (i + 1) * HOUR),
            ...scored(20, "image_only"),
          }),
        );
      }
      hiddenSenders[kind] = await senderIdOf(owner, ids[0]!);
      const col = kind === "trash" ? "in_trash" : kind === "spam" ? "in_spam" : "sender_muted";
      await owner.query(`UPDATE email SET ${col} = true WHERE id = ANY($1::uuid[])`, [ids]);
      if (kind === "muted") await owner.query("UPDATE sender SET muted = true WHERE id = $1", [hiddenSenders[kind]]);
    }
  });
  afterAll(async () => {
    await app.end();
    await owner.end();
  });

  it("the hidden mail really is hidden (sanity check on the fixture)", async () => {
    const r = await owner.query<{ n: string }>("SELECT count(*) AS n FROM email WHERE user_id = $1 AND is_hidden", [user.id]);
    expect(Number(r.rows[0]!.n)).toBe(15);
    const { getInsights } = await import("@/server/queries/insights");
    const ins = await getInsights(user.id, 90);
    expect(ins.totals.emails).toBe(3);
    expect(ins.topSenders.map((s) => s.id)).toEqual([visibleSender]);
  });

  it("frequency spikes, best/worst senders and Top issues leave out trashed, spam and muted-sender mail", async () => {
    const { getInsights } = await import("@/server/queries/insights");
    const ins = await getInsights(user.id, 90);
    const hidden = Object.values(hiddenSenders);
    expect(ins.frequencySpikes.map((s) => s.id).filter((id) => hidden.includes(id))).toEqual([]);
    expect(ins.bestSenders.map((s) => s.id)).toEqual([visibleSender]);
    expect(ins.worstSenders.map((s) => s.id)).toEqual([visibleSender]);
    expect(ins.topIssues).toEqual([{ issue: "contrast", count: 3 }]);
  });
});
