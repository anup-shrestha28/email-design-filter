/**
 * Mailbox token storage and refresh (DESIGN.md §4.4; FREE-TIER.md §4.2 step 2, §9.2).
 *
 *  - Each mailbox has its own random 256-bit DEK, wrapped by the `KeyWrapper` (edf-keys now,
 *    Cloud KMS later). The refresh token is sealed with the DEK, AAD
 *    `[mailbox_id, user_id, "refresh"]`.
 *  - The 1-hour access token is sealed with edf-app's `ACCESS_TOKEN_KEYS` keyring, AAD
 *    `[mailbox_id, user_id, "access"]`, so polls, views and renders never call edf-keys. Only a
 *    refresh and `/revoke` unwrap the DEK.
 *  - Refresh runs under the `refresh_lease_until` lease taken with a conditional UPDATE in its
 *    own short transaction. No transaction or row lock is ever held across an HTTP call
 *    (edf-keys or Google). A worker that finds the lease held waits briefly and re-reads.
 *  - `invalid_grant` → `status='needs_reauth'`, `needs_reauth_since`, tokens nulled, only if the
 *    mailbox is still `active` *and* still holds the refresh token that failed (a reconnect in
 *    between must not be clobbered). Global-incident errors never touch the mailbox.
 */
import { and, eq, schema, sql, withUser } from "@edf/db";
import {
  open as aeadOpen,
  openWithKeyring,
  seal as aeadSeal,
  sealWithKeyring,
  type Keyring,
  type KeyWrapper,
  type WrappedKey,
} from "@edf/crypto";
import { createHash } from "node:crypto";
import type { GetAccessToken } from "./client";
import {
  GlobalIncidentError,
  isGlobalIncident,
  MailboxUnavailableError,
  NeedsReauthError,
  OAuthError,
  TokenIntegrityError,
  TokenRefreshBusyError,
} from "./errors";
import { refreshAccessToken, revokeToken, type TokenSet } from "./oauth";
import { sleep as defaultSleep } from "./util";

type Pool = Parameters<typeof withUser>[0];
const { mailbox } = schema;

/** The AEAD primitives from `@edf/crypto` (injectable for tests). */
export interface TokenAead {
  seal(key: Uint8Array, plaintext: Uint8Array | string, aad: readonly string[]): Buffer;
  open(key: Uint8Array, sealed: Uint8Array, aad: readonly string[]): Buffer;
  sealWithKeyring(ring: Keyring, plaintext: Uint8Array | string, aad: readonly string[]): Buffer;
  openWithKeyring(ring: Keyring, sealed: Uint8Array, aad: readonly string[]): Buffer;
}

export const defaultAead: TokenAead = {
  seal: aeadSeal,
  open: aeadOpen,
  sealWithKeyring,
  openWithKeyring,
};

export type TokenPurpose = "refresh" | "access";

/** AAD `[mailbox_id, user_id, purpose]` (DESIGN.md §4.4, FREE-TIER.md §9.2). */
export function tokenAad(
  mailboxId: string,
  userId: string,
  purpose: TokenPurpose,
): readonly string[] {
  return [mailboxId, userId, purpose];
}

/** A cached access token is used only if it is valid for more than this long. */
export const ACCESS_TOKEN_MIN_REMAINING_MS = 60_000;

export interface NewMailboxTokens {
  mailboxId: string;
  userId: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: Date;
}

/** Column values for `mailbox` (Drizzle property names). */
export interface MailboxTokenColumns {
  dekWrapped: Buffer;
  kekVersion: string;
  refreshTokenEnc: Buffer;
  accessTokenEnc: Buffer;
  accessTokenExpiresAt: Date;
}

/**
 * Seal a freshly connected mailbox's tokens: a new DEK from the `KeyWrapper`, the refresh token
 * under the DEK, the access token under the keyring. The mailbox id must already be known
 * (the caller upserts these columns onto that row).
 */
export async function sealNewMailboxTokens(
  t: NewMailboxTokens,
  deps: { keyWrapper: KeyWrapper; accessRing: Keyring; aead?: TokenAead },
): Promise<MailboxTokenColumns> {
  if (!t.mailboxId || !t.userId)
    throw new TypeError("sealNewMailboxTokens: mailboxId and userId are required");
  if (!t.refreshToken || !t.accessToken)
    throw new TypeError("sealNewMailboxTokens: tokens are required");
  if (!(t.expiresAt instanceof Date) || Number.isNaN(t.expiresAt.getTime())) {
    throw new TypeError("sealNewMailboxTokens: expiresAt must be a valid Date");
  }
  const aead = deps.aead ?? defaultAead;
  const { dek, wrapped, kekVersion } = await deps.keyWrapper.generate({ mailboxId: t.mailboxId });
  try {
    return {
      dekWrapped: wrapped,
      kekVersion,
      refreshTokenEnc: aead.seal(dek, t.refreshToken, tokenAad(t.mailboxId, t.userId, "refresh")),
      accessTokenEnc: aead.sealWithKeyring(
        deps.accessRing,
        t.accessToken,
        tokenAad(t.mailboxId, t.userId, "access"),
      ),
      accessTokenExpiresAt: t.expiresAt,
    };
  } finally {
    dek.fill(0);
  }
}

export interface TokenProviderOptions {
  pool: Pool;
  keyWrapper: KeyWrapper;
  /** edf-app's `ACCESS_TOKEN_KEYS`. */
  accessRing: Keyring;
  /** The connector OAuth client. */
  oauth: { clientId: string; clientSecret: string };
  /** Injectable fetch for Google's token/revoke endpoints (tests). */
  fetch?: typeof fetch;
  aead?: TokenAead;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Lease length; must exceed edf-keys (5 s) + Google (10 s) timeouts. Default 60 s. */
  leaseSeconds?: number;
  /** How long to wait for another worker's refresh. Default 15 s. */
  leaseWaitMs?: number;
  /** Re-read interval while waiting. Default 250 ms. */
  leasePollMs?: number;
  /**
   * Keep unwrapped DEKs in memory for this provider's lifetime, for one user at a time (DESIGN
   * §4.4). Enable only on a provider created per invocation; call `dispose()` when done.
   */
  cacheDeks?: boolean;
}

interface CachedRow {
  status: string;
  accessTokenEnc: Buffer | null;
  accessTokenExpiresAt: Date | null;
}

interface LeaseRow extends CachedRow {
  lease: string;
  dekWrapped: Buffer | null;
  kekVersion: string;
  refreshTokenEnc: Buffer | null;
}

type RefreshOutcome = { kind: "token"; token: string } | { kind: "conflict" };

/**
 * Hands out access tokens for a mailbox (`getAccessToken(userId, mailboxId)`), refreshing
 * under the lease when the cached one is missing, expiring within 60 s, or was rejected by
 * Gmail. Throws `NeedsReauthError`, `GlobalIncidentError`, `MailboxUnavailableError`,
 * `TokenRefreshBusyError` (retriable), `TokenIntegrityError`, or a retriable `OAuthError`.
 */
export class TokenProvider {
  private readonly o: Required<
    Pick<TokenProviderOptions, "leaseSeconds" | "leaseWaitMs" | "leasePollMs" | "cacheDeks">
  > &
    TokenProviderOptions;
  private readonly aead: TokenAead;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private dekCacheUser: string | null = null;
  private readonly dekCache = new Map<string, Buffer>();

  constructor(opts: TokenProviderOptions) {
    this.o = { leaseSeconds: 60, leaseWaitMs: 15_000, leasePollMs: 250, cacheDeks: false, ...opts };
    if (
      !Number.isInteger(this.o.leaseSeconds) ||
      this.o.leaseSeconds < 20 ||
      this.o.leaseSeconds > 600
    ) {
      throw new RangeError("leaseSeconds must be an integer in 20..600");
    }
    this.aead = opts.aead ?? defaultAead;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** A `GetAccessToken` bound to one mailbox, for `new GmailClient({ getAccessToken })`. */
  forMailbox(userId: string, mailboxId: string): GetAccessToken {
    return (opts) => this.getAccessToken(userId, mailboxId, opts);
  }

  async getAccessToken(
    userId: string,
    mailboxId: string,
    opts: { rejectedToken?: string } = {},
  ): Promise<string> {
    const deadline = this.now() + this.o.leaseWaitMs;
    let conflicts = 0;
    for (;;) {
      const row = await this.readRow(userId, mailboxId);
      assertUsable(mailboxId, row);
      const cached = this.openCached(userId, mailboxId, row, opts.rejectedToken);
      if (cached !== null) return cached;
      const lease = await this.tryAcquireLease(userId, mailboxId);
      if (lease) {
        const outcome = await this.refreshUnderLease(userId, mailboxId, lease, opts.rejectedToken);
        if (outcome.kind === "token") return outcome.token;
        if (++conflicts > 2) throw new TokenRefreshBusyError(mailboxId);
        continue;
      }
      if (this.now() >= deadline) throw new TokenRefreshBusyError(mailboxId);
      await this.sleep(this.o.leasePollMs);
    }
  }

  /**
   * Revoke the mailbox's grant at Google (disconnect, FREE-TIER.md §4.9 step 1). Unwraps the DEK
   * to open the refresh token; does not modify the database (the caller then nulls the token
   * columns and sets `disconnecting`).
   */
  async revokeGrant(
    userId: string,
    mailboxId: string,
  ): Promise<{ revoked: boolean; alreadyInvalid: boolean; reason: "no_tokens" | null }> {
    const row = await withUser(this.o.pool, userId, async (db) => {
      const [r] = await db
        .select({
          dekWrapped: mailbox.dekWrapped,
          kekVersion: mailbox.kekVersion,
          refreshTokenEnc: mailbox.refreshTokenEnc,
        })
        .from(mailbox)
        .where(eq(mailbox.id, mailboxId));
      return r ?? null;
    });
    if (!row) throw new MailboxUnavailableError(mailboxId, "missing");
    if (!row.refreshTokenEnc || !row.dekWrapped)
      return { revoked: false, alreadyInvalid: false, reason: "no_tokens" };
    const { dek } = await this.unwrapDek(userId, mailboxId, row.dekWrapped, row.kekVersion);
    try {
      const refreshToken = this.openRefresh(dek, row.refreshTokenEnc, mailboxId, userId);
      const res = await revokeToken(refreshToken, this.o.fetch ? { fetch: this.o.fetch } : {});
      return { revoked: res.revoked, alreadyInvalid: res.alreadyInvalid, reason: null };
    } finally {
      this.releaseDek(dek);
    }
  }

  /** Zero and drop any cached DEKs. */
  dispose(): void {
    for (const k of this.dekCache.values()) k.fill(0);
    this.dekCache.clear();
    this.dekCacheUser = null;
  }

  // ───────────────────────── internals ─────────────────────────

  private readRow(userId: string, mailboxId: string): Promise<CachedRow | null> {
    return withUser(this.o.pool, userId, async (db) => {
      const [r] = await db
        .select({
          status: mailbox.status,
          accessTokenEnc: mailbox.accessTokenEnc,
          accessTokenExpiresAt: mailbox.accessTokenExpiresAt,
        })
        .from(mailbox)
        .where(eq(mailbox.id, mailboxId));
      return r ?? null;
    });
  }

  private openCached(
    userId: string,
    mailboxId: string,
    row: CachedRow,
    rejected: string | undefined,
  ): string | null {
    if (!row.accessTokenEnc || !row.accessTokenExpiresAt) return null;
    if (row.accessTokenExpiresAt.getTime() - this.now() <= ACCESS_TOKEN_MIN_REMAINING_MS)
      return null;
    let token: string;
    try {
      token = this.aead
        .openWithKeyring(
          this.o.accessRing,
          row.accessTokenEnc,
          tokenAad(mailboxId, userId, "access"),
        )
        .toString("utf8");
    } catch {
      return null; // unreadable (e.g. retired key): a refresh overwrites it
    }
    return token.length > 0 && token !== rejected ? token : null;
  }

  private tryAcquireLease(userId: string, mailboxId: string): Promise<LeaseRow | null> {
    return withUser(this.o.pool, userId, async (db) => {
      const [r] = await db
        .update(mailbox)
        .set({ refreshLeaseUntil: sql`now() + make_interval(secs => ${this.o.leaseSeconds})` })
        .where(
          and(
            eq(mailbox.id, mailboxId),
            eq(mailbox.status, "active"),
            sql`(${mailbox.refreshLeaseUntil} IS NULL OR ${mailbox.refreshLeaseUntil} <= now())`,
          ),
        )
        .returning({
          lease: sql<string>`${mailbox.refreshLeaseUntil}::text`,
          status: mailbox.status,
          dekWrapped: mailbox.dekWrapped,
          kekVersion: mailbox.kekVersion,
          refreshTokenEnc: mailbox.refreshTokenEnc,
          accessTokenEnc: mailbox.accessTokenEnc,
          accessTokenExpiresAt: mailbox.accessTokenExpiresAt,
        });
      return r ?? null;
    });
  }

  private async releaseLease(userId: string, mailboxId: string, lease: string): Promise<void> {
    await withUser(this.o.pool, userId, (db) =>
      db
        .update(mailbox)
        .set({ refreshLeaseUntil: null })
        .where(
          and(eq(mailbox.id, mailboxId), sql`${mailbox.refreshLeaseUntil} = ${lease}::timestamptz`),
        ),
    );
  }

  private async refreshUnderLease(
    userId: string,
    mailboxId: string,
    lr: LeaseRow,
    rejected: string | undefined,
  ): Promise<RefreshOutcome> {
    let leaseCleared = false;
    let dek: Buffer | null = null;
    try {
      // Another worker may have completed a refresh between our read and our lease.
      const cached = this.openCached(userId, mailboxId, lr, rejected);
      if (cached !== null) return { kind: "token", token: cached };
      if (!lr.refreshTokenEnc || !lr.dekWrapped)
        throw new MailboxUnavailableError(mailboxId, "no_tokens");

      const unwrapped = await this.unwrapDek(userId, mailboxId, lr.dekWrapped, lr.kekVersion);
      dek = unwrapped.dek;
      const refreshToken = this.openRefresh(dek, lr.refreshTokenEnc, mailboxId, userId);

      let tokens: TokenSet;
      try {
        tokens = await refreshAccessToken(refreshToken, {
          clientId: this.o.oauth.clientId,
          clientSecret: this.o.oauth.clientSecret,
          now: this.now,
          ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
        });
      } catch (err) {
        if (err instanceof OAuthError && err.kind === "invalid_grant") {
          if (await this.markNeedsReauth(userId, mailboxId, lr.refreshTokenEnc)) {
            leaseCleared = true;
            throw new NeedsReauthError(mailboxId);
          }
          // Not transitioned: the mailbox changed status, or a reconnect replaced the token.
          const now = await this.readRow(userId, mailboxId);
          assertUsable(mailboxId, now);
          return { kind: "conflict" };
        }
        if (err instanceof OAuthError && isGlobalIncident(err))
          throw new GlobalIncidentError(err.kind);
        throw err;
      }

      const accessTokenEnc = this.aead.sealWithKeyring(
        this.o.accessRing,
        tokens.accessToken,
        tokenAad(mailboxId, userId, "access"),
      );
      const rotated =
        tokens.refreshToken !== null && tokens.refreshToken !== refreshToken
          ? this.aead.seal(dek, tokens.refreshToken, tokenAad(mailboxId, userId, "refresh"))
          : null;
      leaseCleared = await this.store(userId, mailboxId, lr, {
        accessTokenEnc,
        expiresAt: tokens.expiresAt,
        rewrapped: unwrapped.rewrapped,
        rotated,
      });
      return { kind: "token", token: tokens.accessToken };
    } finally {
      if (dek) this.releaseDek(dek);
      if (!leaseCleared) await this.releaseLease(userId, mailboxId, lr.lease).catch(() => {});
    }
  }

  /** Store the new access token (and a lazily re-wrapped DEK / rotated refresh token). */
  private async store(
    userId: string,
    mailboxId: string,
    lr: LeaseRow,
    v: {
      accessTokenEnc: Buffer;
      expiresAt: Date;
      rewrapped: WrappedKey | null;
      rotated: Buffer | null;
    },
  ): Promise<boolean> {
    const oldRefresh = lr.refreshTokenEnc as Buffer;
    const stored = await withUser(this.o.pool, userId, async (db) => {
      const rows = await db
        .update(mailbox)
        .set({
          accessTokenEnc: v.accessTokenEnc,
          accessTokenExpiresAt: v.expiresAt,
          refreshLeaseUntil: null,
          updatedAt: sql`now()`,
          ...(v.rewrapped
            ? { dekWrapped: v.rewrapped.wrapped, kekVersion: v.rewrapped.kekVersion }
            : {}),
          ...(v.rotated ? { refreshTokenEnc: v.rotated } : {}),
        })
        .where(
          and(
            eq(mailbox.id, mailboxId),
            eq(mailbox.status, "active"),
            sql`${mailbox.refreshTokenEnc} = ${oldRefresh}`,
            sql`(${mailbox.refreshLeaseUntil} = ${lr.lease}::timestamptz OR ${mailbox.refreshLeaseUntil} IS NULL OR ${mailbox.refreshLeaseUntil} <= now())`,
          ),
        )
        .returning({ id: mailbox.id });
      return rows.length > 0;
    });
    if (!stored && v.rotated) {
      // Someone else holds the lease now; never lose a rotated refresh token.
      await withUser(this.o.pool, userId, (db) =>
        db
          .update(mailbox)
          .set({ refreshTokenEnc: v.rotated, updatedAt: sql`now()` })
          .where(
            and(
              eq(mailbox.id, mailboxId),
              eq(mailbox.status, "active"),
              sql`${mailbox.refreshTokenEnc} = ${oldRefresh}`,
            ),
          ),
      );
    }
    return stored;
  }

  /** Conditional `active → needs_reauth` for the refresh token that failed; true if it happened. */
  private markNeedsReauth(
    userId: string,
    mailboxId: string,
    failedRefreshEnc: Buffer,
  ): Promise<boolean> {
    return withUser(this.o.pool, userId, async (db) => {
      const rows = await db
        .update(mailbox)
        .set({
          status: "needs_reauth",
          statusReason: "invalid_grant",
          needsReauthSince: sql`now()`,
          refreshTokenEnc: null,
          accessTokenEnc: null,
          accessTokenExpiresAt: null,
          dekWrapped: null,
          refreshLeaseUntil: null,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(mailbox.id, mailboxId),
            eq(mailbox.status, "active"),
            sql`${mailbox.refreshTokenEnc} = ${failedRefreshEnc}`,
          ),
        )
        .returning({ id: mailbox.id });
      return rows.length > 0;
    });
  }

  private openRefresh(dek: Buffer, sealed: Buffer, mailboxId: string, userId: string): string {
    let token: string;
    try {
      token = this.aead.open(dek, sealed, tokenAad(mailboxId, userId, "refresh")).toString("utf8");
    } catch {
      throw new TokenIntegrityError(mailboxId, "refresh");
    }
    if (!token) throw new TokenIntegrityError(mailboxId, "refresh");
    return token;
  }

  private async unwrapDek(
    userId: string,
    mailboxId: string,
    wrapped: Buffer,
    kekVersion: string,
  ): Promise<{ dek: Buffer; rewrapped: WrappedKey | null }> {
    const key = `${mailboxId}|${kekVersion}|${createHash("sha256").update(wrapped).digest("hex")}`;
    if (this.o.cacheDeks) {
      if (this.dekCacheUser !== userId) {
        this.dispose();
        this.dekCacheUser = userId;
      }
      const hit = this.dekCache.get(key);
      if (hit) return { dek: Buffer.from(hit), rewrapped: null };
    }
    const res = await this.o.keyWrapper.unwrap({ mailboxId, wrapped, kekVersion });
    if (res.dek.byteLength !== 32) {
      res.dek.fill(0);
      throw new TokenIntegrityError(mailboxId, "dek");
    }
    if (this.o.cacheDeks && this.dekCacheUser === userId)
      this.dekCache.set(key, Buffer.from(res.dek));
    return res;
  }

  private releaseDek(dek: Buffer): void {
    dek.fill(0);
  }
}

function assertUsable(mailboxId: string, row: { status: string } | null): asserts row is CachedRow {
  if (!row) throw new MailboxUnavailableError(mailboxId, "missing");
  if (row.status === "needs_reauth") throw new NeedsReauthError(mailboxId);
  if (row.status !== "active") throw new MailboxUnavailableError(mailboxId, row.status);
}
