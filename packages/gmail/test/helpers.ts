import { randomUUID } from "node:crypto";
import { createPool, schema, withUser, type Db } from "@edf/db";
import { appRwUrl } from "./env";

export type Pool = ReturnType<typeof createPool>;

export function appPool(): Pool {
  return createPool({ connectionString: appRwUrl(), max: 10, applicationName: "edf-gmail-test" });
}

export async function createUser(pool: Pool, role: "owner" | "friend" = "friend"): Promise<string> {
  const id = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    "Test",
    `${id}@example.com`,
  ]);
  await withUser(pool, id, (db) =>
    db
      .insert(schema.userSettings)
      .values({ userId: id, role })
      .then(() => undefined),
  );
  return id;
}

export async function createMailbox(
  db: Db,
  userId: string,
  overrides: Partial<typeof schema.mailbox.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.mailbox)
    .values({
      userId,
      provider: "gmail",
      providerAccountId: `sub-${randomUUID()}`,
      emailAddress: `${randomUUID().slice(0, 8)}@example.com`,
      status: "active",
      ...overrides,
    })
    .returning({ id: schema.mailbox.id });
  if (!row) throw new Error("mailbox insert failed");
  return row.id;
}
