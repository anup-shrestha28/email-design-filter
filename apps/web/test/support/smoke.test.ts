import { describe, expect, it } from "vitest";
import { HAS_DB } from "./env";
import { appPool, createMailbox, createUser, seedEmail } from "./db";

describe.skipIf(!HAS_DB)("test harness", () => {
  it("creates users, mailboxes and stores emails through the pipeline", async () => {
    const pool = appPool();
    try {
      const u = await createUser(pool, { role: "owner" });
      const m = await createMailbox(pool, u.id);
      const e = await seedEmail(pool, u.id, m);
      expect(e).toMatch(/^[0-9a-f-]{36}$/);
      const { env } = await import("@/env");
      expect(env().DATABASE_URL).toContain("edf_web_test");
    } finally {
      await pool.end();
    }
  });
});
