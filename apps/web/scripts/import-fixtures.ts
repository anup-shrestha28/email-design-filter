/**
 * DEVELOPMENT ONLY — import `fixtures/emails/**.eml` into a local account through the REAL pipeline
 * (prepare → sender/template context → analysis → transactional store), then optionally render
 * every designable email with local Chrome through the real render orchestration.
 *
 *   pnpm --filter @edf/web import-fixtures [--email demo@edf.local] [--render]
 *
 * Refuses to run against anything but localhost. Fixture mailboxes are marked "fixture:" so the
 * viewer and renderer read the .eml files instead of Gmail (development only).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMime } from "@edf/core";
import { createPool, withUser } from "@edf/db";
import type { TokenProvider } from "@edf/gmail";
import {
  analyzeMessage,
  lookupSender,
  lookupTemplate,
  prepareMessage,
  renderForUser,
  storeEmail,
  userAddresses,
  type PipelineDeps,
  type RendererLike,
} from "@edf/pipeline";

const args = process.argv.slice(2);
const email = args[args.indexOf("--email") + 1] && args.includes("--email") ? args[args.indexOf("--email") + 1]! : "demo@edf.local";
const doRender = args.includes("--render");

const dbUrl = process.env.DATABASE_URL ?? "";
if (!["localhost", "127.0.0.1", "::1"].includes(new URL(dbUrl || "postgres://x@invalid/x").hostname) || process.env.NODE_ENV === "production") {
  console.error("import-fixtures only runs against a local database.");
  process.exit(1);
}

const ROOT = fileURLToPath(new URL("../../../fixtures/emails/", import.meta.url));
const fixtureId = (rel: string) => rel.replace(/\.eml$/i, "").replace(/[^A-Za-z0-9_-]/g, "__").slice(0, 120);

async function listEml(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listEml(full, base)));
    else if (e.name.toLowerCase().endsWith(".eml")) out.push(path.relative(base, full));
  }
  return out.sort();
}

async function labelsFor(rel: string): Promise<string[]> {
  try {
    const sidecar = JSON.parse(await readFile(path.join(ROOT, rel.replace(/\.eml$/i, ".expected.json")), "utf8")) as {
      labels?: unknown;
      input?: { labelIds?: unknown };
    };
    const labels = sidecar.input?.labelIds ?? sidecar.labels;
    if (Array.isArray(labels) && labels.every((l) => typeof l === "string")) return labels as string[];
  } catch {
    // no sidecar
  }
  return ["INBOX", "UNREAD"];
}

async function main(): Promise<void> {
  const pool = createPool({ connectionString: dbUrl, max: 4, applicationName: "edf-import-fixtures" });
  const user = await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  const userId = user.rows[0]?.id;
  if (!userId) {
    console.error(`No user ${email}. Run \`pnpm --filter @edf/web seed-demo\` or sign up first.`);
    process.exit(1);
  }
  const mailboxId = await withUser(pool, userId, async (_db, c) => {
    const existing = await c.query<{ id: string }>("SELECT id FROM mailbox WHERE user_id = $1 AND provider_account_id = $2", [userId, `fixture:${userId}`]);
    if (existing.rows[0]) return existing.rows[0].id;
    const r = await c.query<{ id: string }>(
      `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, history_id, next_poll_at, backfill_state, last_synced_at)
       VALUES ($1, 'gmail', $2, $3, 'active', 1, 'infinity', 'done', now()) RETURNING id`,
      [userId, `fixture:${userId}`, `fixtures+${userId.slice(-6)}@edf.local`],
    );
    return r.rows[0]!.id;
  });

  const files = await listEml(ROOT);
  let stored = 0;
  let skipped = 0;
  const now = new Date();
  for (const [i, rel] of files.entries()) {
    const id = fixtureId(rel);
    const raw = new Uint8Array(await readFile(path.join(ROOT, rel)));
    const parsed = await parseMime(raw);
    const meta = {
      id,
      threadId: id,
      labelIds: await labelsFor(rel),
      snippet: (parsed.text ?? "").replace(/\s+/g, " ").trim().slice(0, 180) || null,
      historyId: String(10_000 + i),
      internalDate: parsed.date ?? new Date(now.getTime() - i * 3_600_000),
      sizeEstimate: raw.byteLength,
    };
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source) VALUES ($1, $2, $3, 'pending_full', 'backfill')
         ON CONFLICT (mailbox_id, provider_message_id) DO UPDATE SET state = 'pending_full'`,
        [mailboxId, userId, id],
      ),
    );
    const addresses = await withUser(pool, userId, (_db, c) => userAddresses(c, userId));
    const prep = prepareMessage(parsed, meta, addresses);
    if (prep.kind === "skip") {
      skipped++;
      console.log(`skip  ${rel}  (${prep.reason})`);
      continue;
    }
    const ctx = await withUser(pool, userId, async (_db, c) => {
      const sender = await lookupSender(c, userId, prep.prepared.fromAddress);
      return { sender, template: await lookupTemplate(c, sender.senderId, prep.prepared.simhash) };
    });
    const result = analyzeMessage(
      {
        parsed, meta, mailboxId, userId, userAddresses: addresses, prior: ctx.sender.prior,
        senderBlockedPersonal: ctx.sender.blockedPersonal, priorContact: false, template: ctx.template, now,
      },
      prep.prepared,
    );
    if (result.kind === "skip") {
      skipped++;
      console.log(`skip  ${rel}  (${result.reason})`);
      continue;
    }
    await withUser(pool, userId, (_db, c) => storeEmail(c, result.record));
    stored++;
    const r = result.record;
    console.log(
      `store ${rel.padEnd(48)} ${r.primaryType.padEnd(16)} ${r.isSubscription ? "sub " : "    "} imp=${r.importance.padEnd(6)} design=${r.designSource}${r.designScore !== null ? ` ${r.designScore}` : ""}`,
    );
  }
  console.log(`\nImported ${stored} emails (${skipped} skipped) into ${email}.`);

  if (doRender) {
    const { LocalChromiumRenderer } = await import("@edf/render");
    const executablePath = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";
    const renderer: RendererLike = {
      host: "local",
      renderBatch: (jobs, opts) => new LocalChromiumRenderer({ executablePath }).renderBatch(jobs, { deadlineMs: opts.deadlineMs }),
    };
    const deps: PipelineDeps = {
      pool,
      tokens: null as unknown as TokenProvider, // fixture mailboxes never use Gmail tokens
      tickEvery: 30,
      governorLevel: async () => 0,
      renderer,
      rawSourceFor: (mb) =>
        mb.providerAccountId.startsWith("fixture:")
          ? async (messageId) => {
              for (const rel of files) if (fixtureId(rel) === messageId) return new Uint8Array(await readFile(path.join(ROOT, rel)));
              return null;
            }
          : null,
      log: (event, fields) => console.log(`  [${event}]`, fields ?? {}),
    };
    // Queue every designable fixture email for a render (development bypasses the daily limits).
    await withUser(pool, userId, (_db, c) =>
      c.query(
        `INSERT INTO render_request (user_id, email_id, kind)
         SELECT $1, e.id, 'on_demand' FROM email e
         WHERE e.mailbox_id = $2 AND e.design_status = 'done' AND NOT e.security_sensitive
         ON CONFLICT (email_id) WHERE state IN ('queued', 'running') DO NOTHING`,
        [userId, mailboxId],
      ),
    );
    for (let round = 0; round < 20; round++) {
      const s = await renderForUser(deps, userId, { fillAllowed: false, samplesAllowed: true, aiSamplesAllowed: false, aiRealtimeAllowed: false, budgetMs: 600_000 });
      console.log(`render round ${round + 1}: rendered ${s.rendered}, failed ${s.failed}, upgraded ${s.upgraded}`);
      if (s.picked === 0) break;
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
