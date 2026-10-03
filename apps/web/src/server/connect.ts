/**
 * Mailbox connect flow (DESIGN.md §4.3; FREE-TIER.md §0, §8.3, §9.1):
 *  - start: fresh session (≤ 10 min), disclosure accepted, invite/cap checks, per-user limit,
 *    state + PKCE verifier + nonce in an ENCRYPTED single-use cookie bound to the session;
 *  - callback: consume the cookie, re-check the invite, exchange the code, require a refresh token
 *    and gmail.readonly, verify the id_token (aud, nonce, email_verified), match getProfile to the
 *    id_token email, bind by `sub` with the conflict rule, seal tokens (DEK from edf-keys), start
 *    the import.
 *  - `reconnect` comes from the URL, so it only lets /start skip the limit pre-checks (to reconnect
 *    one of your mailboxes at the limit). The callback decides: a Google account that isn't
 *    already one of your mailboxes is a NEW mailbox and must fit the per-user limit, re-checked
 *    under a lock on the user's settings row when it is inserted.
 *  - the invite list (DESIGN.md §11.8) is checked on both legs: a friend whose invite the owner
 *    removed can't add mailboxes (the owner has no invite to lose).
 */
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { withSystem, withUser, type PoolClient } from "@edf/db";
import { openWithKeyring, sealWithKeyring } from "@edf/crypto";
import {
  ConnectError,
  GmailClient,
  assertConnectGrant,
  assertProfileEmailMatches,
  buildAuthUrl,
  createPkcePair,
  ensureQuotaRow,
  exchangeCode,
  revokeToken,
  sealNewMailboxTokens,
  verifyConnectorIdToken,
} from "@edf/gmail";
// Not the @edf/pipeline barrel (maintenance.ts has no runtime imports).
import { deleteOrphanSendersAfterMailboxRemoved } from "@edf/pipeline/maintenance";
import { env, IS_PROD } from "@/env";
import { getPool } from "./db";
import { accessTokenKeys, keyWrapper, stateKeys } from "./keys";
import { MAX_MAILBOXES_PER_USER } from "./limits";
import { emit } from "./pipeline-client";
import { connectorOAuth } from "./pipeline-deps";
import type { SessionUser } from "./session";

export const CONNECT_COOKIE = IS_PROD ? "__Host-edf-connect" : "edf-connect";
const STATE_TTL_MS = 10 * 60 * 1000;
const GOOGLE_ACCOUNT_STOP = 90;

interface ConnectState {
  state: string;
  verifier: string;
  nonce: string;
  userId: string;
  sessionId: string;
  createdAt: number;
  reconnect: boolean;
}

export type StartResult =
  | { kind: "redirect"; url: string; cookie: string }
  | { kind: "error"; code: "not_configured" | "consent_required" | "not_invited" | "limit" | "accounts_cap" | "frozen" };

function redirectUri(): string {
  return `${env().APP_ORIGIN.replace(/\/$/, "")}/api/mailboxes/google/callback`;
}

export async function startConnect(user: SessionUser, opts: { loginHint?: string | null; reconnect?: boolean }): Promise<StartResult> {
  let oauth: { clientId: string; clientSecret: string };
  try {
    oauth = connectorOAuth();
  } catch {
    return { kind: "error", code: "not_configured" };
  }
  const pool = await getPool();
  const check = await withUser(pool, user.userId, async (_db, c) => {
    await dropStaleConnectingRows(c, user.userId);
    const s = await c.query<{ consent: Date | null; invited: boolean; mailboxes: string; accounts: string; level: number }>(
      `SELECT us.ai_processing_consent_at AS consent,
              (us.role = 'owner' OR is_invited($2) IS NOT NULL) AS invited,
              (SELECT count(*) FROM mailbox m WHERE m.user_id = us.user_id AND m.status <> 'disconnecting') AS mailboxes,
              (SELECT count(*) FROM oauth_subject_seen) AS accounts,
              coalesce((SELECT (value->>'level')::int FROM app_setting WHERE key = 'governor'), 0) AS level
       FROM user_settings us WHERE us.user_id = $1`,
      [user.userId, user.email],
    );
    return s.rows[0];
  });
  if (check && !check.invited) return { kind: "error", code: "not_invited" };
  if (!check?.consent) return { kind: "error", code: "consent_required" };
  if (check.level >= 3) return { kind: "error", code: "frozen" };
  if (!opts.reconnect && Number(check.mailboxes) >= MAX_MAILBOXES_PER_USER) return { kind: "error", code: "limit" };
  if (!opts.reconnect && Number(check.accounts) >= GOOGLE_ACCOUNT_STOP) return { kind: "error", code: "accounts_cap" };

  const { verifier, challenge } = createPkcePair();
  const st: ConnectState = {
    state: randomBytes(24).toString("base64url"),
    verifier,
    nonce: randomBytes(24).toString("base64url"),
    userId: user.userId,
    sessionId: user.sessionId,
    createdAt: Date.now(),
    reconnect: Boolean(opts.reconnect),
  };
  const sealed = sealWithKeyring(stateKeys(), JSON.stringify(st), ["oauth-connect", user.sessionId]).toString("base64url");
  const url = buildAuthUrl({
    clientId: oauth.clientId,
    redirectUri: redirectUri(),
    state: st.state,
    codeChallenge: challenge,
    nonce: st.nonce,
    loginHint: opts.loginHint ?? null,
    // prompt=consent only on first connect or reconnect (DESIGN.md §4.3) — both are this flow.
    prompt: "consent",
  });
  const cookie = [
    `${CONNECT_COOKIE}=${sealed}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${STATE_TTL_MS / 1000}`,
    ...(IS_PROD ? ["Secure"] : []),
  ].join("; ");
  return { kind: "redirect", url, cookie };
}

export type CallbackResult =
  | { kind: "ok"; mailboxId: string; reconnected: boolean }
  | {
      kind: "error";
      code:
        | "state"
        | "denied"
        | "not_invited"
        | "limit"
        | "no_refresh_token"
        | "scope_missing"
        | "id_token"
        | "email_unverified"
        | "email_mismatch"
        | "stale_session"
        | "accounts_cap"
        | "disconnecting"
        | "failed";
    };

function readState(cookieValue: string | undefined, user: SessionUser): ConnectState | null {
  if (!cookieValue) return null;
  try {
    const plain = openWithKeyring(stateKeys(), Buffer.from(cookieValue, "base64url"), ["oauth-connect", user.sessionId]);
    const st = JSON.parse(plain.toString("utf8")) as ConnectState;
    if (st.userId !== user.userId || st.sessionId !== user.sessionId) return null;
    if (Date.now() - st.createdAt > STATE_TTL_MS) return null;
    return st;
  } catch {
    return null;
  }
}

/** The owner, or a friend still on the invite list. */
async function stillInvited(user: SessionUser): Promise<boolean> {
  const pool = await getPool();
  return withUser(pool, user.userId, async (_db, c) => {
    const r = await c.query<{ ok: boolean }>(
      "SELECT (us.role = 'owner' OR is_invited($2) IS NOT NULL) AS ok FROM user_settings us WHERE us.user_id = $1",
      [user.userId, user.email],
    );
    return r.rows[0]?.ok === true;
  });
}

/**
 * A callback holds its 'connecting' slot for seconds, so one older than this was left by a callback
 * that died (the '<hex>@connecting.invalid' placeholder). It is deleted before the user's mailboxes
 * are counted or listed again, so it neither shows in Settings nor takes a slot until the daily
 * maintenance would remove it. A 'connecting' row never holds tokens or mail (tokens are written
 * together with status 'active').
 */
const STALE_CONNECTING_MINUTES = 15;

export async function dropStaleConnectingRows(c: PoolClient, userId: string): Promise<void> {
  await c.query(
    `DELETE FROM mailbox WHERE user_id = $1 AND status = 'connecting'
       AND created_at < now() - make_interval(mins => $2)`,
    [userId, STALE_CONNECTING_MINUTES],
  );
}

/** The user's mailboxes that count toward MAX_MAILBOXES_PER_USER (the same rule as /start). */
export async function countMailboxes(c: PoolClient, userId: string): Promise<number> {
  await dropStaleConnectingRows(c, userId);
  const r = await c.query<{ n: string }>("SELECT count(*) AS n FROM mailbox WHERE user_id = $1 AND status <> 'disconnecting'", [userId]);
  return Number(r.rows[0]?.n ?? 0);
}

function constantEq(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return x.equals(y);
}

export async function finishConnect(
  user: SessionUser,
  params: { code: string | null; state: string | null; error: string | null },
  cookieValue: string | undefined,
): Promise<CallbackResult> {
  const st = readState(cookieValue, user);
  if (!st || !params.state || !constantEq(st.state, params.state)) return { kind: "error", code: "state" };
  if (params.error || !params.code) return { kind: "error", code: "denied" };
  // Before the code exchange, so no grant is minted for a friend whose invite was removed.
  if (!(await stillInvited(user))) return { kind: "error", code: "not_invited" };
  const oauth = connectorOAuth();

  const tokens = await exchangeCode({ code: params.code, codeVerifier: st.verifier, redirectUri: redirectUri() }, oauth);
  const cleanup = async () => {
    await revokeToken(tokens.refreshToken ?? tokens.accessToken).catch(() => {});
  };
  try {
    assertConnectGrant(tokens);
  } catch (err) {
    await cleanup();
    if (err instanceof ConnectError) {
      return { kind: "error", code: err.reason === "no_refresh_token" ? "no_refresh_token" : err.reason === "scope_missing" ? "scope_missing" : "id_token" };
    }
    throw err;
  }
  const id = await verifyConnectorIdToken(tokens.idToken, { clientId: oauth.clientId, nonce: st.nonce }).catch(() => null);
  if (!id) {
    await cleanup();
    return { kind: "error", code: "id_token" };
  }
  if (!id.emailVerified) {
    await cleanup();
    return { kind: "error", code: "email_unverified" };
  }
  const gmail = new GmailClient({ getAccessToken: async () => tokens.accessToken });
  const profile = await gmail.getProfile();
  try {
    assertProfileEmailMatches(profile.emailAddress, id.email);
  } catch {
    await cleanup();
    return { kind: "error", code: "email_mismatch" };
  }
  // Connecting an address other than the login address needs a very fresh session (≤ 5 min).
  if (profile.emailAddress.toLowerCase() !== user.email.toLowerCase() && Date.now() - user.sessionCreatedAt.getTime() > 5 * 60 * 1000) {
    await cleanup();
    return { kind: "error", code: "stale_session" };
  }

  const pool = await getPool();
  // Existing binding for this Google account? (Read only: nothing is counted or purged yet.)
  const existing = await withSystem(pool, async (_db, c) =>
    (await c.query<{ mailbox_id: string; user_id: string; status: string }>(
      "SELECT mailbox_id, user_id, status FROM lookup_mailbox_binding($1)",
      [id.sub],
    )).rows[0] ?? null,
  );
  if (existing?.status === "disconnecting") {
    await cleanup();
    return { kind: "error", code: "disconnecting" };
  }
  const reuse = existing && existing.user_id === user.userId ? existing.mailbox_id : null;
  // A new mailbox must fit the per-user limit whatever /start was told (`reconnect` is a URL flag).
  // The slot is taken first, before the account is counted toward the Google cap or another user's
  // binding is moved: a placeholder 'connecting' row, counted and inserted under a per-user lock, so
  // two callbacks at once can't both take the last slot, and a refused one has changed nothing.
  // (A placeholder a crash leaves behind is deleted on the user's next connect, see dropStaleConnectingRows,
  // or by maintenance after a day, like any 'connecting' row.)
  const slot = reuse ? null : await withUser(pool, user.userId, async (_db, c) => {
    await c.query("SELECT 1 FROM user_settings WHERE user_id = $1 FOR UPDATE", [user.userId]);
    if ((await countMailboxes(c, user.userId)) >= MAX_MAILBOXES_PER_USER) return null;
    const placeholder = randomBytes(12).toString("hex");
    const r = await c.query<{ id: string }>(
      `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status)
       VALUES ($1, 'gmail', $2, $3, 'connecting') RETURNING id`,
      [user.userId, `pending:${placeholder}`, `${placeholder}@connecting.invalid`],
    );
    return r.rows[0]?.id ?? null;
  });
  if (!reuse && !slot) {
    await cleanup();
    return { kind: "error", code: "limit" };
  }
  const releaseSlot = async () => {
    if (slot) await withUser(pool, user.userId, (_db, c) => c.query("DELETE FROM mailbox WHERE id = $1 AND status = 'connecting'", [slot]));
  };
  // Everything after the slot is taken: a throw gives the slot back.
  const bindMailbox = async (): Promise<CallbackResult> => {
    const subHash = createHash("sha256").update(`google:${id.sub}`).digest("hex");
    // The unverified app's 100-account lifetime cap: count distinct Google accounts, stop new ones at 90.
    const capOk = await withSystem(pool, async (_db, c) => {
      const seen = await c.query("SELECT 1 FROM oauth_subject_seen WHERE sub_hash = $1", [subHash]);
      if (seen.rowCount) return true;
      const n = await c.query<{ n: string }>("SELECT count(*) AS n FROM oauth_subject_seen");
      if (Number(n.rows[0]?.n ?? 0) >= GOOGLE_ACCOUNT_STOP) return false;
      await c.query("INSERT INTO oauth_subject_seen (sub_hash) VALUES ($1) ON CONFLICT DO NOTHING", [subHash]);
      return true;
    });
    if (!capOk) {
      await releaseSlot();
      await cleanup();
      return { kind: "error", code: "accounts_cap" };
    }

    // Bound to another user? (Conflict rule: fresh proof of control wins.)
    if (existing && existing.user_id !== user.userId) {
      // Fresh proof of control wins: purge the old binding NOW (the unique binding keys would block the
      // new row otherwise) and WITHOUT /revoke, which would kill the new grant. Both accounts get an
      // audit entry (shown as a notice in the app). Senders left without emails go with it, as in the
      // disconnect purge (their choices only with the user's last mailbox).
      await withUser(pool, existing.user_id, async (_db, c) => {
        await c.query("DELETE FROM mailbox WHERE id = $1", [existing.mailbox_id]);
        await deleteOrphanSendersAfterMailboxRemoved(c, existing.user_id);
        await c.query("INSERT INTO audit_log (user_id, actor, action, target) VALUES ($1, 'system', 'mailbox.claimed_elsewhere', $2)", [existing.user_id, existing.mailbox_id]);
      });
      await withUser(pool, user.userId, (_db, c) =>
        c.query("INSERT INTO audit_log (user_id, actor, action) VALUES ($1, 'system', 'mailbox.claimed_from_other_account')", [user.userId]),
      );
    }

    const mailboxId = await withUser(pool, user.userId, async (_db, c) => {
      if (reuse) return reuse;
      // The reserved slot becomes this account's binding (the conflict purge above freed its keys).
      const r = await c.query<{ id: string }>(
        `UPDATE mailbox SET provider_account_id = $2, email_address = $3, granted_scopes = $4, history_id = $5::numeric,
                next_poll_at = now(), backfill_state = 'pending', backfill_requested_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'connecting'
         RETURNING id`,
        [slot, id.sub, profile.emailAddress.toLowerCase(), tokens.scopes, profile.historyId],
      );
      const row = r.rows[0];
      if (!row) throw new Error("reserved mailbox slot missing");
      return row.id;
    });

    // Seal tokens outside any transaction (the DEK comes from edf-keys over HTTP).
    const cols = await sealNewMailboxTokens(
      { mailboxId, userId: user.userId, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt },
      { keyWrapper: keyWrapper(), accessRing: accessTokenKeys() },
    );
    const resumeImport = await withUser(pool, user.userId, async (db, c) => {
      // Reconnect keeps the existing cursor (DESIGN.md §4.3); a 404 on the next poll triggers the gap resync.
      await c.query(
        `UPDATE mailbox SET dek_wrapped = $2, kek_version = $3, refresh_token_enc = $4, access_token_enc = $5,
                access_token_expires_at = $6, granted_scopes = $7, status = 'active', status_reason = NULL,
                needs_reauth_since = NULL, next_poll_at = now(), updated_at = now()
         WHERE id = $1`,
        [mailboxId, cols.dekWrapped, cols.kekVersion, cols.refreshTokenEnc, cols.accessTokenEnc, cols.accessTokenExpiresAt, tokens.scopes],
      );
      await ensureQuotaRow(db, mailboxId);
      await c.query(
        "INSERT INTO audit_log (user_id, actor, action, target) VALUES ($1, 'user', $2, $3)",
        [user.userId, reuse ? "mailbox.reconnected" : "mailbox.connected", mailboxId],
      );
      if (!reuse || existing?.status === "active") return false;
      // A finished import is never re-run on reconnect, but one that needs_reauth/paused interrupted
      // (still 'running', its listing gone) goes back to the queue and is asked to resume; a queued one too.
      // 'running' proves it was admitted: the admission mark is kept (or added) so resuming isn't counted again.
      const unfinished = await c.query(
        `UPDATE mailbox SET backfill_state = 'pending',
                backfill_progress = CASE WHEN backfill_state = 'running'
                  THEN backfill_progress || jsonb_build_object('admittedAt', coalesce(backfill_progress->'admittedAt', to_jsonb(now())))
                  ELSE backfill_progress END,
                updated_at = now()
         WHERE id = $1 AND backfill_state IN ('running', 'pending') RETURNING id`,
        [mailboxId],
      );
      return (unfinished.rowCount ?? 0) > 0;
    });
    if (!reuse) {
      await emit({ name: "mailbox/connected", data: { mailboxId, userId: user.userId, generation: 0 } }, `connected-${mailboxId}`);
    } else if (resumeImport) {
      await emit({ name: "backfill/requested", data: { mailboxId, userId: user.userId } }, `backfill-resume-${mailboxId}-${Math.floor(Date.now() / 60_000)}`);
    }
    await emit({ name: "pipeline/kick", data: { reason: "connect" } }, `kick-connect-${mailboxId}-${Math.floor(Date.now() / 60_000)}`);
    return { kind: "ok", mailboxId, reconnected: Boolean(reuse) };
  };
  try {
    return await bindMailbox();
  } catch (err) {
    await releaseSlot().catch(() => {});
    throw err;
  }
}
