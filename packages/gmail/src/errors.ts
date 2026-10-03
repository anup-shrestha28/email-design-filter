/**
 * Typed errors for Gmail, Google OAuth and the token store.
 *
 * Rule: no error message ever contains a token, a response body, an email address or any
 * other content. Only fixed strings, HTTP statuses and Google's machine-readable reason codes
 * (validated against a strict pattern) are included, so errors are safe to log.
 */

/**
 * Gmail failure classes (DESIGN.md §5.5 error table, FREE-TIER.md §4.8).
 *
 * - `unauthorized`: 401 even after one forced token refresh.
 * - `not_found`: 404 on a message/attachment (deleted in Gmail → ledger `skipped`).
 * - `history_expired`: 404 on `history.list` (cursor too old → resync, FREE-TIER §4.2 step 9).
 * - `rate_limited`: 429 or 403 rate-limit reasons; `retryAfterMs` is always set.
 * - `daily_limit`: 403 `dailyLimitExceeded` or a project-level refusal → global pause + alert.
 * - `policy`: 403 `domainPolicy`/`insufficientPermissions`, 400 `failedPrecondition`, other 403s
 *   → mailbox `paused` + user message, never retried.
 * - `bad_request`: any other 400 (a bug on our side); never retried.
 * - `server`: 5xx → retry.
 * - `network`: connection failure or timeout → retry.
 * - `too_large`: the response exceeded the caller's byte cap (streamed; the rest is not read).
 * - `bad_response`: the response failed schema validation (treated as untrusted).
 */
export type GmailErrorKind =
  | "unauthorized"
  | "not_found"
  | "history_expired"
  | "rate_limited"
  | "daily_limit"
  | "policy"
  | "bad_request"
  | "server"
  | "network"
  | "too_large"
  | "bad_response";

const RETRIABLE_GMAIL: ReadonlySet<GmailErrorKind> = new Set([
  "unauthorized",
  "rate_limited",
  "server",
  "network",
]);

export class GmailError extends Error {
  readonly kind: GmailErrorKind;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** Google's machine-readable reason code (e.g. "rateLimitExceeded"), never message text. */
  readonly reason: string | null;
  /** Suggested wait before retrying (always set for `rate_limited`). */
  readonly retryAfterMs: number | null;
  /** The Gmail method, e.g. "messages.get". */
  readonly method: string;

  constructor(
    kind: GmailErrorKind,
    opts: {
      method: string;
      status?: number | null;
      reason?: string | null;
      retryAfterMs?: number | null;
    },
  ) {
    const status = opts.status ?? null;
    const reason = opts.reason ?? null;
    super(
      `Gmail ${opts.method} failed: ${kind}` +
        (status !== null ? ` (HTTP ${status}${reason ? `, ${reason}` : ""})` : ""),
    );
    this.name = "GmailError";
    this.kind = kind;
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.method = opts.method;
  }

  /** True for failures worth retrying later (RetryAfterError); false → NonRetriableError. */
  get retriable(): boolean {
    return RETRIABLE_GMAIL.has(this.kind);
  }
}

export function isGmailError(err: unknown, kind?: GmailErrorKind): err is GmailError {
  return err instanceof GmailError && (kind === undefined || err.kind === kind);
}

/**
 * Google OAuth token-endpoint failures (DESIGN.md §4.4, FREE-TIER.md §4.8).
 * `invalid_client`, `unauthorized_client` and `deleted_client` are global incidents.
 */
export type OAuthErrorKind =
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "deleted_client"
  | "admin_policy_enforced"
  | "network"
  | "other";

export class OAuthError extends Error {
  readonly kind: OAuthErrorKind;
  readonly status: number | null;
  /** Google's `error` code when it matched `^[a-z_]{1,64}$`; never `error_description`. */
  readonly code: string | null;
  /** The operation: "token", "refresh", "revoke", "id_token". */
  readonly operation: string;

  constructor(
    kind: OAuthErrorKind,
    opts: { operation: string; status?: number | null; code?: string | null },
  ) {
    const status = opts.status ?? null;
    super(
      `Google OAuth ${opts.operation} failed: ${kind}` +
        (status !== null ? ` (HTTP ${status}${opts.code ? `, ${opts.code}` : ""})` : ""),
    );
    this.name = "OAuthError";
    this.kind = kind;
    this.status = status;
    this.code = opts.code ?? null;
    this.operation = opts.operation;
  }

  /** Network failures, 5xx and 429 are transient; everything else is final. */
  get retriable(): boolean {
    if (this.kind === "network") return true;
    return (
      this.kind === "other" && this.status !== null && (this.status >= 500 || this.status === 429)
    );
  }
}

const GLOBAL_INCIDENT_KINDS: ReadonlySet<OAuthErrorKind> = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
]);

/**
 * A failure of the OAuth *client* (not of one user's grant): every mailbox is affected, so it
 * must raise a global incident and never mark mailboxes `needs_reauth` (DESIGN.md §4.4).
 */
export function isGlobalIncident(err: unknown): boolean {
  if (err instanceof GlobalIncidentError) return true;
  return err instanceof OAuthError && GLOBAL_INCIDENT_KINDS.has(err.kind);
}

/** The mailbox's grant is gone (`invalid_grant`); the mailbox is now `needs_reauth`. Never retry. */
export class NeedsReauthError extends Error {
  readonly mailboxId: string;
  constructor(mailboxId: string) {
    super("Mailbox needs to be reconnected (invalid_grant)");
    this.name = "NeedsReauthError";
    this.mailboxId = mailboxId;
  }
}

/** The connector OAuth client itself is broken (invalid/deleted/unauthorized client). */
export class GlobalIncidentError extends Error {
  readonly kind: OAuthErrorKind;
  constructor(kind: OAuthErrorKind) {
    super(`Global OAuth incident: ${kind}`);
    this.name = "GlobalIncidentError";
    this.kind = kind;
  }
}

/** The mailbox is missing, not `active`, or has no stored tokens. Not retriable. */
export class MailboxUnavailableError extends Error {
  readonly mailboxId: string;
  /** "missing", "no_tokens" or the mailbox status (e.g. "paused", "disconnecting"). */
  readonly state: string;
  constructor(mailboxId: string, state: string) {
    super(`Mailbox unavailable: ${state}`);
    this.name = "MailboxUnavailableError";
    this.mailboxId = mailboxId;
    this.state = state;
  }
}

/** Another worker held the refresh lease for longer than we were willing to wait. Retriable. */
export class TokenRefreshBusyError extends Error {
  readonly mailboxId: string;
  constructor(mailboxId: string) {
    super("Token refresh lease is held by another worker");
    this.name = "TokenRefreshBusyError";
    this.mailboxId = mailboxId;
  }
}

/**
 * A stored token could not be decrypted (wrong key, wrong AAD or tampering). The mailbox is
 * left untouched: this usually means a key-configuration problem affecting every mailbox.
 */
export class TokenIntegrityError extends Error {
  readonly mailboxId: string;
  readonly which: "refresh" | "dek";
  constructor(mailboxId: string, which: "refresh" | "dek") {
    super(`Stored ${which === "dek" ? "mailbox key" : "refresh token"} could not be opened`);
    this.name = "TokenIntegrityError";
    this.mailboxId = mailboxId;
    this.which = which;
  }
}

/** Why a connect callback must be aborted (DESIGN.md §4.3). */
export type ConnectErrorReason =
  | "no_refresh_token"
  | "scope_missing"
  | "id_token_missing"
  | "id_token_invalid"
  | "nonce_mismatch"
  | "email_unverified"
  | "email_mismatch";

export class ConnectError extends Error {
  readonly reason: ConnectErrorReason;
  constructor(reason: ConnectErrorReason) {
    super(`Mailbox connect aborted: ${reason}`);
    this.name = "ConnectError";
    this.reason = reason;
  }
}
