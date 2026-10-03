/**
 * store.test.ts shares its database with drain.test.ts (fileParallelism is false) and the drain reads
 * the global list_drain_batch, so store.test.ts must not leave an active mailbox or a due ledger row
 * behind: when it ran first, drain tests picked those rows up and failed depending on file order.
 * This runs store.test.ts alone in a child vitest against its own database, then inspects what it left.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { pg } from "@edf/db";
import { HAS_DB, OWNER_URL } from "./env";

const run = promisify(execFile);
const PKG = fileURLToPath(new URL("..", import.meta.url));
const CHILD_SUFFIX = `${(process.env.EDF_TEST_DB_SUFFIX ?? "").slice(0, 10)}sc`;
const CHILD_DB = `edf_pipeline_${CHILD_SUFFIX}_test`;

function urlFor(db: string): string {
  const u = new URL(OWNER_URL);
  u.pathname = `/${db}`;
  return u.toString();
}

describe.skipIf(!HAS_DB)("store.test.ts leaves nothing for the drain", () => {
  it("no active mailbox and no due ledger row remain after the store suite", { timeout: 300_000 }, async () => {
    const vitestBin = fileURLToPath(new URL("vitest.mjs", import.meta.resolve("vitest/package.json")));
    await run(process.execPath, [vitestBin, "run", "test/store.test.ts"], {
      cwd: PKG,
      env: { ...process.env, EDF_TEST_DB_SUFFIX: CHILD_SUFFIX },
      maxBuffer: 64 * 1024 * 1024,
    });
    const c = new pg.Client({ connectionString: urlFor(CHILD_DB) });
    await c.connect();
    try {
      const due = await c.query<{ provider_message_id: string }>("SELECT provider_message_id FROM public.list_drain_batch(2000)");
      expect(due.rows.map((r) => r.provider_message_id)).toEqual([]);
      const active = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM public.mailbox WHERE status = 'active'");
      expect(active.rows[0]?.n).toBe(0);
    } finally {
      await c.end();
      const admin = new pg.Client({ connectionString: urlFor("postgres") });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${CHILD_DB} WITH (FORCE)`).finally(() => admin.end());
    }
  });
});
