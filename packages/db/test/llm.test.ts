/**
 * AI spend settlement (0009, FREE-TIER.md §6.5 layer 3): settle_llm can only release what the
 * user still holds for the reservation's day and month, NULL/NaN/infinite amounts and caps are rejected,
 * and batch items carry their reservation day.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { withSystem, withUser } from "../src/client";
import { migrate, MIGRATIONS_DIR } from "../src/migrate";
import { HAS_DB, OWNER_URL } from "./env";
import { appPool, createEmail, createMailbox, createUser, ownerPool, rejectsWithPg } from "./helpers";

type Caps = [number | null | string, number | null | string, number | null | string];

describe.skipIf(!HAS_DB)("LLM reservations and settlement", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;

  beforeAll(() => {
    pool = appPool();
    owner = ownerPool();
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  const reserve = (u: string, usd: number | string, day: string, caps: Caps = [100, 100, 100]) =>
    withUser(pool, u, async (_db, c) =>
      (await c.query("SELECT reserve_llm($1, $2, $3::date, $4, $5, $6) AS ok", [u, usd, day, ...caps])).rows[0].ok as boolean,
    );
  const settle = (u: string, reserved: number | string, actual: number | string, day: string) =>
    withUser(pool, u, (_db, c) => c.query("SELECT settle_llm($1, $2, $3, $4::date)", [u, reserved, actual, day]));
  const global = async (period: string) =>
    Number((await pool.query("SELECT reserved_usd FROM llm_budget_global WHERE period = $1", [period])).rows[0]?.reserved_usd ?? 0);
  const rows = (u: string) =>
    withUser(pool, u, async (_db, c) =>
      Object.fromEntries(
        (await c.query("SELECT scope, day::text AS day, reserved_usd FROM llm_budget WHERE user_id = $1", [u])).rows.map((r) => [
          `${r.scope}:${r.day}`,
          Number(r.reserved_usd),
        ]),
      ),
    );

  it("a settle on the wrong day or month releases nothing of other users' reservations", async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    expect(await reserve(a, 1, "2041-03-31")).toBe(true);
    expect(await reserve(b, 2, "2041-04-01")).toBe(true);
    // A's batch ends on April 1 and is (wrongly) settled against April: A holds nothing there.
    await settle(a, 1, 0.1, "2041-04-01");
    expect(await global("2041-04-01")).toBe(2);
    // Settled against the reservation day, March is released exactly.
    await settle(a, 1, 0.1, "2041-03-31");
    expect(await global("2041-03-01")).toBe(0.1);
    expect(await rows(a)).toEqual({ "month:2041-03-01": 0.1, "day:2041-03-31": 0.1 });
  });

  it("repeated or oversized settles are bounded by the user's own holdings", async () => {
    const [a, b] = [await createUser(pool), await createUser(pool)];
    const day = "2041-06-10";
    expect(await reserve(b, 4, day)).toBe(true);
    expect(await reserve(a, 0.4, day)).toBe(true);
    await settle(a, 0.4, 0.1, day);
    expect(await global("2041-06-01")).toBe(4.1);
    await settle(a, 0.4, 0.1, day); // a second settle can release at most A's remaining $0.10
    expect(await global("2041-06-01")).toBe(4);
    await settle(a, 10, 0, day);
    expect(await global("2041-06-01")).toBe(4); // B's $4 is untouched
    expect(await rows(a)).toEqual({ "month:2041-06-01": 0, "day:2041-06-10": 0 });
    expect(await reserve(a, 4.4, day, [4.5, 100, 100])).toBe(false);
    await rejectsWithPg(settle(a, 1000, 0, day), /invalid amount/);
    // Actual above the reservation is charged to the user and the global row alike.
    expect(await reserve(a, 0.1, day)).toBe(true);
    await settle(a, 0.1, 0.15, day);
    expect(await global("2041-06-01")).toBe(4.15);
    expect(await rows(a)).toEqual({ "month:2041-06-01": 0.15, "day:2041-06-10": 0.15 });
  });

  it("reserve_llm and settle_llm reject NULL, NaN and infinite amounts and caps", async () => {
    const u = await createUser(pool);
    const day = "2041-07-01";
    await rejectsWithPg(reserve(u, 5, day, [100, 1000, null]), /invalid amount/);
    await rejectsWithPg(reserve(u, 5, day, [null, 1000, 1000]), /invalid amount/);
    await rejectsWithPg(reserve(u, 5, day, [100, "NaN", "NaN"]), /invalid amount/);
    await rejectsWithPg(reserve(u, 9, day, ["NaN", "NaN", "NaN"]), /invalid amount/);
    await rejectsWithPg(reserve(u, "NaN", day), /invalid amount/);
    await rejectsWithPg(reserve(u, 5, day, [100, "Infinity", "Infinity"]), /invalid amount/);
    await rejectsWithPg(reserve(u, 5, day, [100, 100, "Infinity"]), /invalid amount/);
    await rejectsWithPg(reserve(u, 5, day, ["Infinity", 100, 100]), /invalid amount/);
    await rejectsWithPg(reserve(u, "Infinity", day), /invalid amount/);
    expect(await global("2041-07-01")).toBe(0);
    expect(await reserve(u, 1, day)).toBe(true);
    await rejectsWithPg(settle(u, "NaN", 0, day), /invalid amount/);
    await rejectsWithPg(settle(u, 1, "NaN", day), /invalid amount/);
    await rejectsWithPg(settle(u, "Infinity", 0, day), /invalid amount/);
    await rejectsWithPg(settle(u, 1, "Infinity", day), /invalid amount/);
    await rejectsWithPg(
      withUser(pool, u, (_db, c) => c.query("SELECT settle_llm($1, NULL, 0, $2::date)", [u, day])),
      /invalid amount/,
    );
    expect(await global("2041-07-01")).toBe(1);
    // The tables refuse NaN too.
    await rejectsWithPg(owner.query("UPDATE llm_budget_global SET cap_usd = 'NaN' WHERE period = '2041-07-01'"), /llm_budget_global_not_nan/);
  });

  it("batch items keep their reservation day; lookup/list return it and settled_usd to app_rw", async () => {
    const u = await createUser(pool);
    const emailId = await withUser(pool, u, async (db) => createEmail(db, u, await createMailbox(db, u)));
    const batchId = randomUUID();
    await withSystem(pool, (_db, c) =>
      c.query("INSERT INTO ai_batch (id, purpose, state, reserved_usd, item_count) VALUES ($1, 'classify', 'submitted', 0.05, 1)", [batchId]),
    );
    const cid = `cl_${randomUUID().replaceAll("-", "")}`;
    await withUser(pool, u, (_db, c) =>
      c.query(
        `INSERT INTO ai_batch_item (custom_id, batch_id, user_id, email_id, purpose, reserved_usd, reserved_day)
         VALUES ($1, $2, $3, $4, 'classify', 0.05, '2041-08-31')`,
        [cid, batchId, u, emailId],
      ),
    );
    const look = (await pool.query("SELECT reserved_day::text AS day, settled_usd FROM lookup_batch_item($1)", [cid])).rows[0];
    expect(look).toEqual({ day: "2041-08-31", settled_usd: null });
    const list = (await pool.query("SELECT custom_id, reserved_day::text AS day, settled_usd FROM list_batch_items($1)", [batchId])).rows;
    expect(list).toEqual([{ custom_id: cid, day: "2041-08-31", settled_usd: null }]);
    // The reservation day is required.
    await rejectsWithPg(
      withUser(pool, u, (_db, c) =>
        c.query(
          `INSERT INTO ai_batch_item (custom_id, batch_id, user_id, email_id, purpose, reserved_usd) VALUES ($1, $2, $3, $4, 'classify', 0.05)`,
          [`${cid.slice(0, 40)}x`, batchId, u, emailId],
        ),
      ),
      /reserved_day/,
    );
    const priv = (
      await owner.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('app_rw', p.oid, 'EXECUTE') AS rw
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('lookup_batch_item', 'list_batch_items', 'llm_owner_month_reserved', 'reserve_llm', 'settle_llm')
         ORDER BY p.proname`,
      )
    ).rows;
    expect(priv).toEqual(
      ["list_batch_items", "llm_owner_month_reserved", "lookup_batch_item", "reserve_llm", "settle_llm"].map((proname) => ({
        proname,
        owner: "app_system",
        rw: true,
      })),
    );
  });

  it("llm_owner_month_reserved sums only the owner's month reservations", async () => {
    const day = "2041-09-15";
    const before = Number((await pool.query("SELECT llm_owner_month_reserved($1::date) AS v", [day])).rows[0].v);
    const [o, f] = [await createUser(pool, "owner"), await createUser(pool, "friend")];
    expect(await reserve(o, 0.7, day)).toBe(true);
    expect(await reserve(f, 0.2, day)).toBe(true);
    const v = await withUser(pool, f, async (_db, c) =>
      Number((await c.query("SELECT llm_owner_month_reserved($1::date) AS v", ["2041-09-30"])).rows[0].v),
    );
    expect(v - before).toBeCloseTo(0.7, 4);
  });

  it("0009 backfills an in-flight batch's reservation day, including reservations made before midnight", async () => {
    // A private database migrated to 0008, with a batch submitted across midnight, then migrated on.
    const base = new URL(OWNER_URL);
    const name = base.pathname.slice(1).replace(/_test$/, "_mig_test");
    const admin = new URL(OWNER_URL);
    admin.pathname = "/postgres";
    const target = new URL(OWNER_URL);
    target.pathname = `/${name}`;
    const dropDb = async () => {
      const a = new pg.Client({ connectionString: admin.toString() });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      return a;
    };
    const a = await dropDb();
    await a.query(`CREATE DATABASE ${name}`);
    await a.end();
    const dir = await mkdtemp(path.join(tmpdir(), "edf-mig-"));
    try {
      for (const f of (await readdir(MIGRATIONS_DIR)).filter((n) => /^000[1-8]_.*\.sql$/.test(n))) {
        await copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      }
      await migrate({ ownerUrl: target.toString(), dir });
      const c = new pg.Client({ connectionString: target.toString() });
      await c.connect();
      try {
        await c.query(`INSERT INTO "user" (id, name, email) VALUES ('u1', 'T', 'u1@example.com'), ('u2', 'T', 'u2@example.com')`);
        const emailOf = async (u: string) => {
          const m = await c.query(`INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status)
                                   VALUES ($1, 'gmail', $1, $1 || '@g.example', 'active') RETURNING id`, [u]);
          const e = await c.query(`INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject,
                                                      is_subscription, primary_type, type_source, search_tsv)
                                   VALUES ($1, $2, 'm1', 1, now(), 's', true, 'promotional', 'pending', to_tsvector('simple', 'x')) RETURNING id`,
            [u, m.rows[0].id]);
          return e.rows[0].id as string;
        };
        // u1 reserved at 23:59:58 on March 31; u2 reserved on both days, the last one on April 1.
        await c.query(`INSERT INTO llm_budget (user_id, scope, day, reserved_usd) VALUES
          ('u1', 'month', '2041-03-01', 0.05), ('u1', 'day', '2041-03-31', 0.05),
          ('u2', 'month', '2041-03-01', 0.05), ('u2', 'day', '2041-03-31', 0.05),
          ('u2', 'month', '2041-04-01', 0.05), ('u2', 'day', '2041-04-01', 0.05)`);
        const batchId = randomUUID();
        await c.query(`INSERT INTO ai_batch (id, purpose, state, item_count, created_at)
                       VALUES ($1, 'classify', 'submitted', 2, '2041-04-01 00:00:01+00')`, [batchId]);
        await c.query(`INSERT INTO ai_batch_item (custom_id, batch_id, user_id, email_id, purpose, reserved_usd)
                       VALUES ('cl_u1', $1, 'u1', $2, 'classify', 0.05), ('cl_u2', $1, 'u2', $3, 'classify', 0.05)`,
          [batchId, await emailOf("u1"), await emailOf("u2")]);
      } finally {
        await c.end();
      }
      await migrate({ ownerUrl: target.toString() });
      const c2 = new pg.Client({ connectionString: target.toString() });
      await c2.connect();
      try {
        const r = await c2.query("SELECT custom_id, reserved_day::text AS day FROM ai_batch_item ORDER BY custom_id");
        expect(r.rows).toEqual([
          { custom_id: "cl_u1", day: "2041-03-31" },
          { custom_id: "cl_u2", day: "2041-04-01" },
        ]);
      } finally {
        await c2.end();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await (await dropDb()).end();
    }
  });
});
