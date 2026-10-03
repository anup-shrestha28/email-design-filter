/**
 * DEVELOPMENT ONLY — make the demo account's design gallery show only real, renderable emails.
 *
 *   pnpm --filter @edf/web demo-reset [--dry-run]
 *
 * seed-demo.ts invents emails with no HTML source behind them, so their previews can never render.
 * This deletes the emails in the demo account's SEED mailbox only — the one seed-demo.ts creates
 * (provider_account_id "demo-sub-<user id>", address alex.rivera@example.com, never connected: no
 * OAuth tokens, no data key) — with their dependent rows in foreign-key order, as the demo user
 * (RLS via withUser). The user, their sign-in, settings and the fixture mailbox are kept; senders,
 * templates and the seed mailbox left with no emails are removed. Then it re-runs
 * scripts/import-fixtures.ts with --render (the real pipeline + local Chrome) and prints the
 * gallery's verdict counts.
 *
 * Safety: refuses to run against anything but localhost; only ever targets the demo account
 * (DEMO_EMAIL, default demo@edf.local — an --email naming anyone else is refused); and refuses,
 * deleting nothing, when that account has any other mailbox (e.g. a real connected Gmail) or a
 * seed / fixture mailbox that holds OAuth tokens.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPool, withUser, type pg } from "@edf/db";
import type { DesignBand } from "@edf/design/types";
import { verdictOf, type Verdict } from "../src/lib/gallery";

const args = process.argv.slice(2);
/** The demo account seed-demo.ts creates — the only account this script ever touches. */
const DEMO_EMAIL = (process.env.DEMO_EMAIL ?? "demo@edf.local").trim().toLowerCase();
const emailArg = args.indexOf("--email");
if (emailArg >= 0 && (args[emailArg + 1] ?? "").trim().toLowerCase() !== DEMO_EMAIL) {
  console.error(
    `demo-reset only resets the demo account (${DEMO_EMAIL}); it never touches other users.`,
  );
  process.exit(1);
}
const email = DEMO_EMAIL;
const dryRun = args.includes("--dry-run");

const dbUrl = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(dbUrl).hostname;
  } catch {
    return "";
  }
})();
if (
  !["localhost", "127.0.0.1", "::1"].includes(host) ||
  process.env.NODE_ENV === "production" ||
  process.env.VERCEL
) {
  console.error("demo-reset only runs against a local database.");
  process.exit(1);
}

/** Where seed-demo.ts / import-fixtures.ts put their data (see those scripts). */
const SEED_ADDRESS = "alex.rivera@example.com";
const NO_SECRETS =
  "m.refresh_token_enc IS NULL AND m.access_token_enc IS NULL AND m.dek_wrapped IS NULL";
/** seed-demo's mailbox: its exact account id and address, and never connected (no tokens, no key). */
const SEED_MAILBOX = `m.provider_account_id = ('demo-sub-' || m.user_id) AND m.email_address = '${SEED_ADDRESS}' AND ${NO_SECRETS}`;
/** import-fixtures' mailbox (kept). */
const FIXTURE_MAILBOX = `m.provider_account_id = ('fixture:' || m.user_id) AND ${NO_SECRETS}`;

/** The emails with no previewable source: only those in the demo account's seed mailbox. */
const TARGETS = `SELECT e.id FROM email e JOIN mailbox m ON m.id = e.mailbox_id AND m.user_id = e.user_id
                 WHERE e.user_id = $1 AND ${SEED_MAILBOX}`;

/** Mailboxes that are neither the seed nor the fixture mailbox (e.g. a real Gmail): any one stops the reset. */
async function foreignMailboxes(
  c: pg.PoolClient,
  userId: string,
): Promise<Array<{ email_address: string; status: string }>> {
  return (
    await c.query<{ email_address: string; status: string }>(
      `SELECT m.email_address::text AS email_address, m.status FROM mailbox m
       WHERE m.user_id = $1 AND NOT (${SEED_MAILBOX}) AND NOT (${FIXTURE_MAILBOX})`,
      [userId],
    )
  ).rows;
}

async function deleteUnpreviewable(
  c: pg.PoolClient,
  userId: string,
): Promise<Record<string, number>> {
  const n: Record<string, number> = {};
  const ids = (await c.query<{ id: string }>(TARGETS, [userId])).rows.map((r) => r.id);
  // $1 = the user, $2 = the doomed email ids (every statement also names the user; RLS is the backstop).
  const run = async (label: string, text: string) => {
    n[label] = (await c.query(text, text.includes("$2") ? [userId, ids] : [userId])).rowCount ?? 0;
  };
  // 1. Loose references to the doomed emails (ON DELETE SET NULL columns), cleared explicitly.
  await run(
    "template refs cleared",
    `UPDATE email_template SET exemplar_email_id = NULL
    WHERE user_id = $1 AND exemplar_email_id IN (SELECT unnest($2::uuid[]))`,
  );
  await run(
    "template AI refs cleared",
    `UPDATE email_template SET ai_source_email_id = NULL
    WHERE user_id = $1 AND ai_source_email_id IN (SELECT unnest($2::uuid[]))`,
  );
  await run(
    "render refs cleared",
    `UPDATE email_analysis SET render_ref_email_id = NULL
    WHERE user_id = $1 AND render_ref_email_id IN (SELECT unnest($2::uuid[]))`,
  );
  await run(
    "ai batch refs cleared",
    `UPDATE ai_batch_item SET email_id = NULL
    WHERE user_id = $1 AND email_id IN (SELECT unnest($2::uuid[]))`,
  );
  // 2. Rows owned by the emails.
  for (const table of [
    "deal",
    "user_feedback",
    "review_share",
    "render_request",
    "email_analysis",
  ]) {
    await run(
      table,
      `DELETE FROM ${table} WHERE user_id = $1 AND email_id IN (SELECT unnest($2::uuid[]))`,
    );
  }
  await run(
    "message_ledger",
    `DELETE FROM message_ledger l USING email e
    WHERE l.user_id = $1 AND e.id IN (SELECT unnest($2::uuid[]))
      AND l.mailbox_id = e.mailbox_id AND l.provider_message_id = e.provider_message_id`,
  );
  // 3. The emails.
  await run("email", `DELETE FROM email WHERE user_id = $1 AND id IN (SELECT unnest($2::uuid[]))`);
  // 4. What only those emails used: templates, senders and seed mailboxes with nothing left.
  const orphanSenders = `SELECT s.id FROM sender s WHERE s.user_id = $1
    AND NOT EXISTS (SELECT 1 FROM email e WHERE e.user_id = s.user_id AND e.sender_id = s.id)`;
  await run(
    "ai batch template refs cleared",
    `UPDATE ai_batch_item SET template_id = NULL WHERE user_id = $1
    AND template_id IN (SELECT t.id FROM email_template t WHERE t.user_id = $1 AND t.sender_id IN (${orphanSenders}))`,
  );
  await run(
    "email_template",
    `DELETE FROM email_template WHERE user_id = $1 AND sender_id IN (${orphanSenders})`,
  );
  await run(
    "sender feedback",
    `DELETE FROM user_feedback WHERE user_id = $1 AND sender_id IN (${orphanSenders})`,
  );
  await run(
    "deal sender refs cleared",
    `UPDATE deal SET sender_id = NULL WHERE user_id = $1 AND sender_id IN (${orphanSenders})`,
  );
  await run("sender", `DELETE FROM sender WHERE user_id = $1 AND id IN (${orphanSenders})`);
  const emptySeedMailboxes = `SELECT m.id FROM mailbox m WHERE m.user_id = $1 AND ${SEED_MAILBOX}
    AND NOT EXISTS (SELECT 1 FROM email e WHERE e.user_id = m.user_id AND e.mailbox_id = m.id)`;
  for (const table of ["message_ledger", "sync_run", "gmail_quota"]) {
    await run(
      `${table} (seed mailbox)`,
      `DELETE FROM ${table} WHERE user_id = $1 AND mailbox_id IN (${emptySeedMailboxes})`,
    );
  }
  await run("mailbox", `DELETE FROM mailbox WHERE user_id = $1 AND id IN (${emptySeedMailboxes})`);
  return n;
}

/** Re-run the real fixture import (with renders) as its own process, so its logic lives in one place. */
function importFixtures(): Promise<void> {
  const script = fileURLToPath(new URL("./import-fixtures.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", script, "--email", email, "--render"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: process.env,
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`import-fixtures exited with ${code}`)),
    );
  });
}

async function galleryCounts(
  pool: pg.Pool,
  userId: string,
): Promise<{ total: number; verdicts: Record<Verdict, number> }> {
  const rows = await withUser(
    pool,
    userId,
    async (_db, c) =>
      (
        await c.query<{
          design_score: number | null;
          design_band: DesignBand | null;
          design_capped: boolean | null;
          design_provisional: boolean | null;
          design_issues: string[];
          design_source: string;
          caps: string[] | null;
          confidence: number | null;
          signals: unknown;
        }>(
          `SELECT e.design_score, e.design_band, e.design_capped, e.design_provisional, e.design_issues, e.design_source,
                a.caps, a.confidence::float8 AS confidence,
                CASE WHEN jsonb_typeof(a.score_summary -> 'signals') = 'object' THEN a.score_summary -> 'signals'
                     ELSE public.summary_signals(a.checks) END AS signals
         FROM email e LEFT JOIN email_analysis a ON a.email_id = e.id AND a.user_id = e.user_id
         WHERE e.user_id = $1 AND NOT e.is_hidden AND NOT e.security_sensitive AND e.design_status NOT IN ('plain_text', 'skipped')`,
          [userId],
        )
      ).rows,
  );
  const verdicts: Record<Verdict, number> = { good: 0, bad: 0, ok: 0, unscored: 0 };
  for (const r of rows) {
    verdicts[
      verdictOf({
        score: r.design_score,
        band: r.design_band,
        capped: r.design_capped,
        provisional: r.design_provisional,
        caps: r.caps ?? [],
        issues: r.design_issues,
        source: r.design_source,
        coverageConfidence: r.confidence,
        signals: r.signals,
      })
    ]++;
  }
  return { total: rows.length, verdicts };
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: dbUrl, max: 2, applicationName: "edf-demo-reset" });
  try {
    const user = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [
      email,
    ]);
    const userId = user.rows[0]?.id;
    if (!userId) {
      console.error(`No user ${email}. Run \`pnpm --filter @edf/web seed-demo\` or sign up first.`);
      process.exit(1);
    }
    const foreign = await withUser(pool, userId, (_db, c) => foreignMailboxes(c, userId));
    if (foreign.length) {
      console.error(
        `${email} has ${foreign.length} other mailbox(es) (${foreign.map((m) => `${m.email_address}, ${m.status}`).join("; ")}) — ` +
          "maybe a real connected Gmail. demo-reset only clears seed-demo's made-up data, so it stopped without deleting anything.",
      );
      process.exit(1);
    }
    const before = await withUser(
      pool,
      userId,
      async (_db, c) =>
        (await c.query<{ n: string }>(`SELECT count(*) AS n FROM (${TARGETS}) t`, [userId]))
          .rows[0]!.n,
    );
    console.log(`${email}: ${before} seed-demo emails have no previewable source.`);
    if (dryRun) {
      console.log("Dry run: nothing deleted.");
      return;
    }
    // Checked again inside the deleting transaction, so a mailbox connected meanwhile still stops it.
    const deleted = await withUser(pool, userId, async (_db, c) => {
      if ((await foreignMailboxes(c, userId)).length)
        throw new Error("Another mailbox appeared; nothing deleted.");
      return deleteUnpreviewable(c, userId);
    });
    for (const [label, count] of Object.entries(deleted))
      if (count) console.log(`  ${label}: ${count}`);

    await importFixtures();

    const { total, verdicts } = await galleryCounts(pool, userId);
    console.log(
      `\nGallery for ${email}: ${total} emails — good ${verdicts.good}, bad ${verdicts.bad}, ok ${verdicts.ok}, unscored ${verdicts.unscored}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
