/**
 * Shared helpers for the server action/query tests. The session module itself is real (it reads the
 * role from user_settings under RLS and enforces the fresh-session rule); only Better Auth's cookie
 * lookup is replaced, through `sessionFor()` values handed to the `@/server/auth` mock in each file.
 */
import { randomUUID } from "node:crypto";
import type { pg } from "@edf/db";

export interface FakeSession {
  user: { id: string; email: string; name: string; image: string | null };
  session: { id: string; token: string; createdAt: Date };
}

/** A Better Auth `getSession()` result for `user`, created `ageMs` ago (default: just now). */
export function sessionFor(user: { id: string; email: string; name: string }, ageMs = 0): FakeSession {
  return {
    user: { id: user.id, email: user.email, name: user.name, image: null },
    session: { id: `s_${randomUUID()}`, token: `t_${randomUUID()}`, createdAt: new Date(Date.now() - ageMs) },
  };
}

/** Read one row as the migration owner (bypasses RLS) — used only to assert what the app did. */
export async function ownerRow<T extends Record<string, unknown>>(owner: pg.Pool, text: string, params: unknown[]): Promise<T | undefined> {
  const r = await owner.query<T>(text, params);
  return r.rows[0];
}

export async function senderIdOf(owner: pg.Pool, emailId: string): Promise<string> {
  const r = await owner.query<{ sender_id: string }>("SELECT sender_id FROM email WHERE id = $1", [emailId]);
  const id = r.rows[0]?.sender_id;
  if (!id) throw new Error("email has no sender");
  return id;
}

/** Record overrides for mail from `address` (the fixture's sender block is fixed, so override both). */
export function fromSender(address: string, over: { displayName?: string; https?: string[]; mailto?: string[] } = {}) {
  const domain = address.split("@")[1]!;
  return {
    fromAddress: address,
    fromName: over.displayName ?? "Northwind",
    sender: {
      address,
      displayName: over.displayName ?? "Northwind",
      domain,
      espPlatform: "Klaviyo",
      listUnsubscribe: { https: over.https ?? ["https://northwind.example/u"], mailto: over.mailto ?? [] },
      oneClick: true,
      authSummary: { trust: "trusted" },
    },
  };
}
