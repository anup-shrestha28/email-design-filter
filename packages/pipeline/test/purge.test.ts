/**
 * Account deletion (DATA-MODEL.md §6): mailboxes are purged in bounded batches first, and the final
 * `DELETE FROM "user"` cascade gets a longer statement_timeout than the usual 25 s. A failed attempt
 * keeps what it purged, and the next attempt finishes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type pg, withUser } from "@edf/db";
import { deleteAccount } from "../src/purge";
import type { PipelineDeps } from "../src/deps";
import { appRwUrl, HAS_DB, OWNER_URL } from "./env";

describe.skipIf(!HAS_DB)("deleteAccount", () => {
  let pool: pg.Pool;
  let owner: pg.Pool;

  beforeAll(() => {
    pool = createPool({ connectionString: appRwUrl(), max: 4 });
    owner = createPool({ connectionString: OWNER_URL, max: 2 });
  });
  afterAll(async () => {
    await pool?.end();
    await owner?.end();
  });

  /** One mailbox per entry of `emailsPerMailbox`, each with that many emails. */
  async function seedAccount(...emailsPerMailbox: number[]): Promise<string> {
    const userId = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'T', $2)`, [userId, `${userId}@example.com`]);
    await withUser(pool, userId, async (_db, c) => {
      await c.query("INSERT INTO user_settings (user_id) VALUES ($1)", [userId]);
      for (const [i, emails] of emailsPerMailbox.entries()) {
        const m = await c.query<{ id: string }>(
          `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status) VALUES ($1, 'gmail', $2, $3, 'active') RETURNING id`,
          [userId, randomUUID(), `${userId}.${i}@gmail.example`],
        );
        await c.query(
          `INSERT INTO email (user_id, mailbox_id, provider_message_id, gmail_history_id, received_at, subject, is_subscription,
                              primary_type, type_source, search_tsv)
           SELECT $1, $2, 'm' || g, 100, now(), 'Hello', true, 'promotional', 'rule', to_tsvector('simple', 'hello')
           FROM generate_series(1, $3::int) g`,
          [userId, m.rows[0]!.id, emails],
        );
      }
    });
    return userId;
  }

  function fakeDeps(): { deps: PipelineDeps; revoked: string[] } {
    const revoked: string[] = [];
    const tokens = { revokeGrant: async (_u: string, mailboxId: string) => (revoked.push(mailboxId), { revoked: true, alreadyInvalid: false }) };
    return { deps: { pool, tokens, log: () => {} } as unknown as PipelineDeps, revoked };
  }

  const counts = async (userId: string) =>
    (
      await owner.query<{ users: number; mailboxes: number; emails: number; deleted: number }>(
        `SELECT (SELECT count(*)::int FROM "user" WHERE id = $1) AS users,
                (SELECT count(*)::int FROM mailbox WHERE user_id = $1) AS mailboxes,
                (SELECT count(*)::int FROM email WHERE user_id = $1) AS emails,
                (SELECT count(*)::int FROM audit_log WHERE user_id = $1 AND action = 'account.deleted') AS deleted`,
        [userId],
      )
    ).rows[0]!;

  it(
    "purges in batches, gives the final cascade more than 25 s, and a retry finishes a failed attempt",
    async () => {
      const userId = await seedAccount(12_000);
      // The cascade into user_settings fails the first time, then takes 31 s: longer than the usual
      // 25 s statement_timeout and the pool's 30 s client-side query_timeout.
      const fn = `slow_delete_${userId}`;
      const seq = `slow_delete_seq_${userId}`;
      await owner.query(`CREATE SEQUENCE ${seq}`);
      await owner.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           IF OLD.user_id = '${userId}' THEN
             IF nextval('${seq}') = 1 THEN RAISE EXCEPTION 'first attempt fails'; END IF;
             PERFORM pg_sleep(31);
           END IF;
           RETURN OLD;
         END $$`,
      );
      await owner.query(`CREATE TRIGGER ${fn} BEFORE DELETE ON user_settings FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try {
        const { deps, revoked } = fakeDeps();

        await expect(deleteAccount(deps, userId)).rejects.toThrow(/first attempt fails/);
        // The mailbox was purged in committed batches; the user row and its audit entry rolled back.
        expect(await counts(userId)).toEqual({ users: 1, mailboxes: 0, emails: 0, deleted: 0 });

        await deleteAccount(deps, userId);
        expect(await counts(userId)).toEqual({ users: 0, mailboxes: 0, emails: 0, deleted: 1 });
        expect(revoked).toHaveLength(1);
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON user_settings`);
        await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
        await owner.query(`DROP SEQUENCE IF EXISTS ${seq}`);
      }
    },
    120_000,
  );

  it(
    "a retry after a purge failed mid-mailbox resumes it without revoking again, then does the next mailbox",
    async () => {
      const userId = await seedAccount(6_000, 6_000);
      // The second 5,000-email batch of this account fails once, so the first mailbox is left half purged.
      // (SECURITY DEFINER: the batches run as the app role, which can't use the test's sequence.)
      const fn = `fail_purge_${userId}`;
      const seq = `fail_purge_seq_${userId}`;
      await owner.query(`CREATE SEQUENCE ${seq}`);
      await owner.query(
        `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
         BEGIN
           IF EXISTS (SELECT 1 FROM gone WHERE user_id = '${userId}') AND nextval('${seq}') = 2 THEN
             RAISE EXCEPTION 'purge interrupted';
           END IF;
           RETURN NULL;
         END $$`,
      );
      await owner.query(`CREATE TRIGGER ${fn} AFTER DELETE ON email REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
      try {
        const { deps, revoked } = fakeDeps();

        await expect(deleteAccount(deps, userId)).rejects.toThrow(/purge interrupted/);
        expect(await counts(userId)).toEqual({ users: 1, mailboxes: 2, emails: 7_000, deleted: 0 });
        const statuses = await owner.query<{ id: string; status: string }>(
          "SELECT id, status FROM mailbox WHERE user_id = $1 ORDER BY status",
          [userId],
        );
        expect(statuses.rows.map((r) => r.status)).toEqual(["active", "disconnecting"]);
        expect(revoked).toEqual([statuses.rows[1]!.id]);

        await deleteAccount(deps, userId);
        expect(await counts(userId)).toEqual({ users: 0, mailboxes: 0, emails: 0, deleted: 1 });
        // Each mailbox revoked exactly once: the half-purged one only on the first attempt.
        expect(revoked.toSorted()).toEqual(statuses.rows.map((r) => r.id).toSorted());
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS ${fn} ON email`);
        await owner.query(`DROP FUNCTION IF EXISTS ${fn}()`);
        await owner.query(`DROP SEQUENCE IF EXISTS ${seq}`);
      }
    },
    120_000,
  );
});
