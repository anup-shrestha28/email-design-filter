/**
 * R1-15 (server side): the email page's `actions` say why "Run AI review" is off for a suspicious
 * email that can otherwise be analysed (`aiReason`), so the button isn't disabled without a word.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import type { getPool as getAppPool } from "@/server/db";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

vi.mock("@/server/session", () => ({
  UnauthorizedError: class extends Error {},
  StaleSessionError: class extends Error {},
  requireUserOrThrow: async () => null,
}));

describe.skipIf(!HAS_DB)("the email page's AI review reason", () => {
  const pool = appPool();
  let appPoolOf: typeof getAppPool | null = null;
  afterAll(async () => {
    await pool.end();
    await (await appPoolOf?.())?.end();
  });

  it("is set for suspicious mail and absent otherwise", async () => {
    appPoolOf = (await import("@/server/db")).getPool;
    const { getEmailDetail } = await import("@/server/queries/email");
    const u = await createUser(pool, { role: "owner" });
    const mailboxId = await createMailbox(pool, u.id);
    const bad = await seedEmail(pool, u.id, mailboxId, { suspicious: true, authResult: "fail" });
    const good = await seedEmail(pool, u.id, mailboxId);

    const b = (await getEmailDetail(u.id, bad, "owner"))!;
    expect(b.actions.canRunAiReview).toBe(false);
    expect(b.actions.reason).toBeNull();
    expect(b.actions.aiReason).toMatch(/never sent to AI/);

    const g = (await getEmailDetail(u.id, good, "owner"))!;
    expect(g.actions.aiReason ?? null).toBeNull();
  });
});
