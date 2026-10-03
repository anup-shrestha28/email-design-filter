import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createPool, withUser, type Db } from "../src/client";
import { email, mailbox, sender, userSettings } from "../src/schema";
import { sql } from "drizzle-orm";
import { appRwUrl, OWNER_URL } from "./env";
import { pgError } from "../src/errors";

export function appPool(): pg.Pool {
  return createPool({ connectionString: appRwUrl(), max: 10, applicationName: "edf-test" });
}

export function ownerPool(): pg.Pool {
  return createPool({ connectionString: OWNER_URL, max: 2, applicationName: "edf-test-owner" });
}

export async function createUser(pool: pg.Pool, role: "owner" | "friend" = "friend"): Promise<string> {
  const id = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [id, "Test", `${id}@example.com`]);
  await withUser(pool, id, (db) => db.insert(userSettings).values({ userId: id, role }).then(() => undefined));
  return id;
}

export async function createMailbox(
  db: Db,
  userId: string,
  overrides: Partial<typeof mailbox.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(mailbox)
    .values({
      userId,
      provider: "gmail",
      providerAccountId: `sub-${randomUUID()}`,
      emailAddress: `${randomUUID().slice(0, 8)}@example.com`,
      status: "active",
      ...overrides,
    })
    .returning({ id: mailbox.id });
  if (!row) throw new Error("mailbox insert failed");
  return row.id;
}

export async function createSender(db: Db, userId: string, address = `news@${randomUUID().slice(0, 6)}.example`): Promise<string> {
  const now = new Date();
  const [row] = await db
    .insert(sender)
    .values({ userId, address, domain: address.split("@")[1] ?? "example", firstSeenAt: now, lastSeenAt: now })
    .returning({ id: sender.id });
  if (!row) throw new Error("sender insert failed");
  return row.id;
}

export async function createEmail(
  db: Db,
  userId: string,
  mailboxId: string,
  overrides: Partial<typeof email.$inferInsert> & { searchText?: string } = {},
): Promise<string> {
  const { searchText, ...rest } = overrides;
  const [row] = await db
    .insert(email)
    .values({
      userId,
      mailboxId,
      providerMessageId: randomUUID().replaceAll("-", "").slice(0, 16),
      gmailHistoryId: "100",
      receivedAt: new Date(),
      subject: "Hello",
      isSubscription: true,
      primaryType: "promotional",
      typeSource: "rule",
      searchTsv: sql`to_tsvector('simple', ${searchText ?? "hello world"})`,
      ...rest,
    })
    .returning({ id: email.id });
  if (!row) throw new Error("email insert failed");
  return row.id;
}

/** Assert that a promise rejects with a Postgres error whose message (or cause) matches. */
export async function rejectsWithPg(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const info = pgError(err);
    const text = `${info?.message ?? ""} ${err instanceof Error ? err.message : ""}`;
    if (!re.test(text)) throw new Error(`expected error matching ${re}, got: ${info?.message ?? String(err)}`, { cause: err });
    return;
  }
  throw new Error(`expected rejection matching ${re}`);
}
