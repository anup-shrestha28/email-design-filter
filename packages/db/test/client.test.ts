/**
 * Connection settings that must survive Neon's pooled endpoint (PgBouncer, transaction mode): the
 * statement timeout is app_rw's database default and is set per transaction, never as a startup parameter.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { withSystem, withUser } from "../src/client";
import { HAS_DB } from "./env";
import { appPool, createUser } from "./helpers";

describe.skipIf(!HAS_DB)("client transactions", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = appPool();
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("statement_timeout applies inside withUser/withSystem and is not a session (startup) setting", async () => {
    const show = async (c: pg.PoolClient) => (await c.query<{ statement_timeout: string }>("SHOW statement_timeout")).rows[0]!.statement_timeout;
    const u = await createUser(pool);
    expect(await withUser(pool, u, (_db, c) => show(c))).toBe("25s");
    expect(await withSystem(pool, (_db, c) => show(c))).toBe("25s");
    // Outside a transaction (Better Auth, boot checks, purge) app_rw's database default is in force:
    // it comes from the server ("database user"), not from a startup parameter ("client").
    const c = await pool.connect();
    try {
      const r = await c.query<{ setting: string; source: string }>("SELECT setting, source FROM pg_settings WHERE name = 'statement_timeout'");
      expect(r.rows[0]).toEqual({ setting: "25000", source: "database user" });
    } finally {
      c.release();
    }
  });
});
