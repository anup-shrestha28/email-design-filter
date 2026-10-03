/**
 * DB helpers for apps/web tests: users (with role), mailboxes and realistic emails stored through the
 * real pipeline store (RLS-scoped, as app_rw). Every helper creates fresh ids, so tests never collide.
 */
import { randomUUID } from "node:crypto";
import { createPool, pg, withUser } from "@edf/db";
import { storeEmail, type EmailRecord } from "@edf/pipeline";
import { appRwUrl, OWNER_URL } from "./env";

export function appPool(): pg.Pool {
  return createPool({ connectionString: appRwUrl(), max: 6, applicationName: "edf-web-test" });
}

/** Owner connection (BYPASSRLS) — only for arranging states the app itself can't create. */
export function ownerPool(): pg.Pool {
  return createPool({ connectionString: OWNER_URL, max: 2, applicationName: "edf-web-test-owner" });
}

/** The invite a real account was created from (beta_allowlist is closed to app_rw, so as the owner). */
export async function inviteEmail(email: string, role: "owner" | "friend" = "friend"): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL, application_name: "edf-web-test-owner" });
  await c.connect();
  try {
    await c.query("INSERT INTO beta_allowlist (email, role, used_at) VALUES ($1, $2, now()) ON CONFLICT (email) DO NOTHING", [email, role]);
  } finally {
    await c.end();
  }
}

/**
 * A user as the invite gate leaves one: the user row, user_settings and a used invite (session.ts
 * signs out a friend who is no longer on the invite list). `invited: false` skips the invite.
 */
export async function createUser(
  pool: pg.Pool,
  opts: { role?: "owner" | "friend"; email?: string; name?: string; invited?: boolean } = {},
): Promise<{ id: string; email: string; name: string; role: "owner" | "friend" }> {
  const id = `u_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const email = opts.email ?? `${id}@example.com`;
  const name = opts.name ?? "Test User";
  const role = opts.role ?? "friend";
  if (opts.invited !== false) await inviteEmail(email, role);
  await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, true)`, [id, name, email]);
  await withUser(pool, id, (_db, c) => c.query("INSERT INTO user_settings (user_id, role) VALUES ($1, $2)", [id, role]));
  return { id, email, name, role };
}

export async function createMailbox(
  pool: pg.Pool,
  userId: string,
  opts: { status?: string; address?: string; backfillState?: string } = {},
): Promise<string> {
  return withUser(pool, userId, async (_db, c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, backfill_state, history_id)
       VALUES ($1, 'gmail', $2, $3, $4, $5, 1) RETURNING id`,
      [userId, `sub-${randomUUID()}`, opts.address ?? `${randomUUID().slice(0, 8)}@gmail.example`, opts.status ?? "active", opts.backfillState ?? "done"],
    );
    return r.rows[0]!.id;
  });
}

/** Store one email through the real pipeline store; returns its id. */
export async function seedEmail(pool: pg.Pool, userId: string, mailboxId: string, over: Partial<EmailRecord> = {}): Promise<string> {
  const rec = emailRecord(userId, mailboxId, over);
  await withUser(pool, userId, (_db, c) => storeEmail(c, rec));
  const r = await withUser(pool, userId, (_db, c) =>
    c.query<{ id: string }>("SELECT id FROM email WHERE mailbox_id = $1 AND provider_message_id = $2", [mailboxId, rec.providerMessageId]),
  );
  return r.rows[0]!.id;
}

/** A realistic promotional email record (override any field). */
export function emailRecord(userId: string, mailboxId: string, over: Partial<EmailRecord> = {}): EmailRecord {
  return {
    mailboxId,
    userId,
    providerMessageId: over.providerMessageId ?? randomUUID().replaceAll("-", "").slice(0, 16),
    providerThreadId: null,
    historyId: "1000",
    receivedAt: new Date("2026-09-20T10:00:00Z"),
    subject: "30% off everything",
    fromAddress: "hello@northwind.example",
    fromName: "Northwind",
    snippet: "Our autumn sale…",
    labelIds: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
    sizeBytes: 40000,
    htmlBytes: 30000,
    language: "en",
    securitySensitive: false,
    isSubscription: true,
    subscriptionScore: 90,
    primaryType: "promotional",
    subtype: "sale",
    secondaryTags: [],
    typeConfidence: 0.9,
    typeSource: "rule",
    importance: "normal",
    importanceScore: 20,
    importanceReasons: ["type:promotional"],
    importanceExpiresAt: null,
    listId: null,
    oneClickUnsubscribe: true,
    authResult: "pass",
    suspicious: false,
    espPlatform: "Klaviyo",
    trackerCount: 1,
    utmCampaign: "autumn",
    designStatus: "done",
    designSource: "static",
    designAiState: "pending",
    designScore: null,
    designBand: null,
    designCapped: null,
    designProvisional: null,
    designIssues: [],
    designConfidence: null,
    fontSource: "static",
    fontFamilies: ["Montserrat"],
    usesWebFonts: true,
    deals: [
      { kind: "percent_off", value: 30, currency: null, isUpTo: false, minSpend: null, code: "AUTUMN30", startsAt: null, endsAt: new Date("2026-09-21T06:59:59Z"), endsAtConfidence: 0.9, source: "regex" },
    ],
    searchText: "30% off everything Northwind hello@northwind.example",
    sender: { address: "hello@northwind.example", displayName: "Northwind", domain: "northwind.example", espPlatform: "Klaviyo", listUnsubscribe: { https: ["https://northwind.example/u"], mailto: [] }, oneClick: true, authSummary: { trust: "trusted" } },
    templateSimhash: "123456789",
    analysis: {
      scoringVersion: "test", rendererVersion: null, features: { v: 1 }, checks: [], pillarScores: [], rawScore: null, caps: [],
      confidence: 0.225, trust: {}, scoreSummary: { coverage: "static" }, aiReview: null, aiModel: null, renderRefEmailId: null,
      rendererHost: null, chromiumVersion: null, renderMs: null,
    },
    ...over,
  };
}
