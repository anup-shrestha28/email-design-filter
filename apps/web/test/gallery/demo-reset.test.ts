/**
 * scripts/demo-reset.ts safety (run as a child process against the test database, dry run only —
 * a real run would re-import and render every fixture):
 *  - it only ever targets the demo account: an --email naming anyone else is refused
 *  - it counts (and would delete) only the emails in seed-demo's never-connected seed mailbox —
 *    not the fixture mailbox's, not any other mailbox's
 *  - it refuses, deleting nothing, when the demo account has any other mailbox (e.g. a real
 *    connected Gmail) or a seed mailbox that holds OAuth tokens
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { pg } from "@edf/db";
import { HAS_DB, appRwUrl } from "../support/env";
import { appPool, createMailbox, createUser, ownerPool, seedEmail } from "../support/db";

const WEB = fileURLToPath(new URL("../..", import.meta.url));

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/demo-reset.ts", ...args], {
    cwd: WEB,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      DATABASE_URL: appRwUrl(),
      ...env,
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe.skipIf(!HAS_DB)("demo-reset only touches the demo account's seed data", () => {
  let app: pg.Pool;
  let owner: pg.Pool;
  let demo: Awaited<ReturnType<typeof createUser>>;
  let seedMb: string;
  let env: Record<string, string>;

  const emailCount = async (userId: string) =>
    Number(
      (
        await owner.query<{ n: string }>("SELECT count(*) AS n FROM email WHERE user_id = $1", [
          userId,
        ])
      ).rows[0]!.n,
    );

  beforeAll(async () => {
    app = appPool();
    owner = ownerPool();
    demo = await createUser(app, { email: `demo-${randomUUID().slice(0, 8)}@edf.local` });
    env = { DEMO_EMAIL: demo.email };
    // seed-demo's mailbox (made-up data, never connected) and import-fixtures' mailbox.
    seedMb = (
      await owner.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, kek_version, history_id)
         VALUES ($1, 'gmail', 'demo-sub-' || $1, 'alex.rivera@example.com', 'active', 'local:v1', 1) RETURNING id`,
        [demo.id],
      )
    ).rows[0]!.id;
    const fixtureMb = (
      await owner.query<{ id: string }>(
        `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, history_id)
         VALUES ($1, 'gmail', 'fixture:' || $1, 'fixtures@edf.local', 'active', 1) RETURNING id`,
        [demo.id],
      )
    ).rows[0]!.id;
    await seedEmail(app, demo.id, seedMb, { subject: "seed 1" });
    await seedEmail(app, demo.id, seedMb, { subject: "seed 2" });
    await seedEmail(app, demo.id, fixtureMb, { subject: "fixture 1" });
  });

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it("counts only the seed mailbox's emails", () => {
    const r = run(env, "--dry-run");
    expect(r.out).toContain(`${demo.email}: 2 seed-demo emails`);
    expect(r.out).toContain("Dry run: nothing deleted.");
    expect(r.code).toBe(0);
  });

  it("refuses an --email that isn't the demo account", async () => {
    const other = await createUser(app);
    const r = run(env, "--email", other.email, "--dry-run");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/only resets the demo account/);
    expect(run(env, "--email", demo.email.toUpperCase(), "--dry-run").code).toBe(0);
  });

  it("stops without deleting anything when the demo account has a real mailbox", async () => {
    const real = await createMailbox(app, demo.id, { address: "me@gmail.example" });
    await seedEmail(app, demo.id, real, { subject: "real mail" });
    const before = await emailCount(demo.id);
    const r = run(env);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/other mailbox/);
    expect(r.out).toContain("me@gmail.example");
    expect(await emailCount(demo.id)).toBe(before);
    await owner.query("DELETE FROM email WHERE mailbox_id = $1", [real]);
    await owner.query("DELETE FROM mailbox WHERE id = $1", [real]);
  });

  it("a seed-looking mailbox that holds OAuth tokens counts as real", async () => {
    await owner.query("UPDATE mailbox SET refresh_token_enc = '\\x00'::bytea WHERE id = $1", [
      seedMb,
    ]);
    const r = run(env, "--dry-run");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/other mailbox/);
    await owner.query("UPDATE mailbox SET refresh_token_enc = NULL WHERE id = $1", [seedMb]);
    expect(run(env, "--dry-run").code).toBe(0);
  });
});
