/**
 * Tenant isolation and role safety (DATA-MODEL.md §4, §8; FREE-TIER.md §10 "CI RLS tests are
 * extended to cover each new function and table"). Runs against a freshly migrated database
 * as the runtime role app_rw.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { withSystem, withUser } from "../src/client";
import { assertRuntimeRole, UnsafeDatabaseRoleError } from "../src/boot";
import { auditLog, deal, email, mailbox, messageLedger, renderRequest } from "../src/schema";
import { HAS_DB } from "./env";
import { appPool, createEmail, createMailbox, createSender, createUser, ownerPool, rejectsWithPg } from "./helpers";

describe.skipIf(!HAS_DB)("row-level security & roles", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;
  let u1: string;
  let u2: string;
  let m1: string;
  let m2: string;
  let e1: string;
  let e2: string;

  beforeAll(async () => {
    pool = appPool();
    owner = ownerPool();
    u1 = await createUser(pool, "owner");
    u2 = await createUser(pool);
    await withUser(pool, u1, async (db) => {
      m1 = await createMailbox(db, u1);
      e1 = await createEmail(db, u1, m1, { searchText: "autumn sale boots jackets" });
    });
    await withUser(pool, u2, async (db) => {
      m2 = await createMailbox(db, u2);
      e2 = await createEmail(db, u2, m2, { searchText: "autumn newsletter boots" });
    });
  });

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  it("boot assertion passes for app_rw and rejects the owner role", async () => {
    await expect(assertRuntimeRole(pool)).resolves.toBeUndefined();
    await expect(assertRuntimeRole(owner)).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });

  it("app_rw cannot create objects in the public schema", async () => {
    await expect(pool.query("CREATE TABLE nope (id int)")).rejects.toThrow(/permission denied/);
  });

  it("fails closed without a tenant context", async () => {
    const rows = await withSystem(pool, (db) => db.select().from(email));
    expect(rows).toHaveLength(0);
    const direct = await pool.query("SELECT count(*)::int AS n FROM email");
    expect(direct.rows[0].n).toBe(0);
  });

  it("scopes reads to the tenant, and the setting does not leak into the next transaction", async () => {
    const mine = await withUser(pool, u1, (db) => db.select({ id: email.id, userId: email.userId }).from(email));
    expect(mine.map((r) => r.id)).toEqual([e1]);
    expect(new Set(mine.map((r) => r.userId))).toEqual(new Set([u1]));
    // A pooled connection that previously had app.user_id set now reads '' → sees nothing.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [u1]);
      await client.query("COMMIT");
      const after = await client.query("SELECT count(*)::int AS n FROM email");
      expect(after.rows[0].n).toBe(0);
    } finally {
      client.release();
    }
  });

  it("rejects inserts for another tenant (RLS WITH CHECK)", async () => {
    await rejectsWithPg(
      withUser(pool, u1, (db) => createEmail(db, u2, m2)),
      /row-level security/,
    );
  });

  it("cross-tenant UPDATE and DELETE affect zero rows", async () => {
    const updated = await withUser(pool, u1, (db) =>
      db.update(email).set({ subject: "pwned" }).where(eq(email.id, e2)).returning({ id: email.id }),
    );
    expect(updated).toHaveLength(0);
    const deleted = await withUser(pool, u1, (db) => db.delete(email).where(eq(email.id, e2)).returning({ id: email.id }));
    expect(deleted).toHaveLength(0);
  });

  it("composite tenant FKs stop pointing at another tenant's rows", async () => {
    // u1 cannot attach a deal to u2's email even though it knows the id (FK checks bypass RLS).
    await rejectsWithPg(
      withUser(pool, u1, (db) =>
        db.insert(deal).values({ emailId: e2, userId: u1, kind: "percent_off", value: 10, source: "regex" }),
      ),
      /foreign key/,
    );
    // …nor put an email into u2's mailbox under its own user id.
    await rejectsWithPg(withUser(pool, u1, (db) => createEmail(db, u1, m2)), /foreign key/);
    // …nor queue a render for u2's email.
    await rejectsWithPg(
      withUser(pool, u1, (db) => db.insert(renderRequest).values({ userId: u1, emailId: e2, kind: "on_demand" })),
      /foreign key/,
    );
  });

  it("deal dedupe makes re-extraction idempotent", async () => {
    await withUser(pool, u1, async (db) => {
      const values = { emailId: e1, userId: u1, kind: "percent_off" as const, value: 30, code: "AUTUMN30", source: "regex" as const };
      const a = await db.insert(deal).values(values).onConflictDoNothing().returning({ id: deal.id });
      const b = await db.insert(deal).values(values).onConflictDoNothing().returning({ id: deal.id });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(0);
    });
  });

  it("cursor compare-and-set accepts NULL → n and never moves backwards", async () => {
    await withUser(pool, u1, async (db) => {
      const cas = (v: string) =>
        db
          .update(mailbox)
          .set({ historyId: v })
          .where(sql`${mailbox.id} = ${m1} AND (${mailbox.historyId} IS NULL OR ${mailbox.historyId} < ${v}::numeric)`)
          .returning({ id: mailbox.id });
      expect(await cas("100")).toHaveLength(1);
      expect(await cas("18446744073709551615")).toHaveLength(1); // uint64 max compares exactly
      expect(await cas("200")).toHaveLength(0);
    });
  });

  it("audit_log is append-only for the app and readable only for the own user", async () => {
    await withUser(pool, u1, (db) => db.insert(auditLog).values({ userId: u1, actor: "user", action: "test" }));
    await withSystem(pool, (db) => db.insert(auditLog).values({ actor: "system", action: "anon" }));
    await expect(pool.query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/permission denied/);
    await expect(pool.query("DELETE FROM audit_log")).rejects.toThrow(/permission denied/);
    const seen = await withUser(pool, u2, (db) => db.select().from(auditLog));
    expect(seen).toHaveLength(0);
  });

  it("search_emails applies the tenant predicate and supports a prefix token", async () => {
    const hits = await withUser(pool, u1, async (_db, client) =>
      (await client.query("SELECT id FROM search_emails($1, $2, 50)", ["autumn", ""])).rows.map((r) => r.id),
    );
    expect(hits).toEqual([e1]);
    const prefix = await withUser(pool, u1, async (_db, client) =>
      (await client.query("SELECT id FROM search_emails($1, $2, 50)", ["", "jack"])).rows.map((r) => r.id),
    );
    expect(prefix).toEqual([e1]);
    const none = await withSystem(pool, async (_db, client) =>
      (await client.query("SELECT id FROM search_emails($1, $2, 50)", ["autumn", ""])).rows,
    );
    expect(none).toHaveLength(0);
  });

  it("search_senders is tenant-scoped and escapes LIKE wildcards", async () => {
    await withUser(pool, u1, (db) => createSender(db, u1, "hello@northwind.example"));
    await withUser(pool, u2, (db) => createSender(db, u2, "hello@northwind-2.example"));
    const hits = await withUser(pool, u1, async (_db, client) =>
      (await client.query("SELECT id FROM search_senders($1, 20)", ["northwind"])).rows,
    );
    expect(hits).toHaveLength(1);
    const wildcard = await withUser(pool, u1, async (_db, client) =>
      (await client.query("SELECT id FROM search_senders($1, 20)", ["%"])).rows,
    );
    expect(wildcard).toHaveLength(0);
  });

  it("beta_allowlist is only reachable through the definer functions; management is owner-only", async () => {
    await expect(pool.query("SELECT * FROM beta_allowlist")).rejects.toThrow(/permission denied/);
    await owner.query("INSERT INTO beta_allowlist (email, role) VALUES ('Friend@Example.com', 'friend')");
    const role = await pool.query("SELECT is_invited($1) AS r", ["friend@example.COM"]);
    expect(role.rows[0].r).toBe("friend");
    const claimed = await pool.query("SELECT claim_invite($1) AS r", ["friend@example.com"]);
    expect(claimed.rows[0].r).toBe("friend");
    // u2 is a friend → cannot add invites; u1 is the owner → can.
    await expect(
      withUser(pool, u2, (_db, c) => c.query("SELECT add_invite($1, 'friend')", ["x@example.com"])),
    ).rejects.toThrow(/owner only/);
    await withUser(pool, u1, (_db, c) => c.query("SELECT add_invite($1, 'friend')", ["y@example.com"]));
    await expect(
      withUser(pool, u1, (_db, c) => c.query("SELECT add_invite($1, 'owner')", ["z@example.com"])),
    ).rejects.toThrow(/invalid role/);
    const list = await withUser(pool, u1, async (_db, c) => (await c.query("SELECT email FROM list_invites()")).rows);
    expect(list.map((r) => r.email)).toContain("y@example.com");
  });

  it("account deletion cascades without a tenant context (the Better Auth path)", async () => {
    const u3 = await createUser(pool);
    await withUser(pool, u3, async (db) => {
      const m3 = await createMailbox(db, u3);
      const s3 = await createSender(db, u3);
      await createEmail(db, u3, m3, { senderId: s3 });
      await db.insert(messageLedger).values({ mailboxId: m3, userId: u3, providerMessageId: "abc", state: "stored", source: "sync" });
    });
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [u3]);
    const left = await owner.query(
      `SELECT (SELECT count(*) FROM email WHERE user_id = $1) + (SELECT count(*) FROM mailbox WHERE user_id = $1)
            + (SELECT count(*) FROM sender WHERE user_id = $1) + (SELECT count(*) FROM message_ledger WHERE user_id = $1)
            + (SELECT count(*) FROM user_settings WHERE user_id = $1) AS n`,
      [u3],
    );
    expect(Number(left.rows[0].n)).toBe(0);
  });

  it("every SECURITY DEFINER function is owned by app_system, pins search_path and is not PUBLIC-executable", async () => {
    const { rows } = await owner.query(`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef`);
    expect(rows.length).toBeGreaterThanOrEqual(25);
    for (const r of rows) {
      expect(r.owner, r.proname).toBe("app_system");
      expect(r.public_exec, r.proname).toBe(false);
      const sp = (r.proconfig as string[] | null)?.find((c) => c.startsWith("search_path="));
      expect(sp, r.proname).toMatch(/^search_path=pg_catalog, (public, )?pg_temp$/);
    }
    const sys = await owner.query(`SELECT rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'app_system'`);
    expect(sys.rows[0]).toEqual({ rolbypassrls: false, rolcanlogin: false });
  });

  it("app_system is not granted CREATE on the schema after migrations", async () => {
    const { rows } = await owner.query(`SELECT has_schema_privilege('app_system', 'public', 'CREATE') AS c`);
    expect(rows[0].c).toBe(false);
  });
});
