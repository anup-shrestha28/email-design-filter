/**
 * Draining the message ledger (FREE-TIER.md §4.6; DESIGN.md §5.5): round-robin across mailboxes,
 * new-mail rows before backfill rows, one message at a time with its own try/catch and its own
 * commit. Every Gmail call reserves quota first. Nothing here holds a transaction across HTTP.
 *
 * Personal mail: a metadata fetch first for non-category mail; if the sender has list/ESP headers,
 * the headers alone show a hard automated signal, or the user has never written to them, the full
 * message is fetched and classified with body signals (so automated Primary-tab mail — bank
 * alerts, receipts, password resets — is never mistaken for personal). Mail from people the user
 * corresponds with is skipped without ever fetching its body.
 */
import { withSystem, withUser, isDatabaseUnavailable, type PoolClient } from "@edf/db";
import { MimeParseError, classifyAutomated, parseMime } from "@edf/core";
import type { GmailMessageMeta, LedgerSkipReason, ParsedEmail } from "@edf/core/types";
import {
  DEFAULT_RAW_MAX_BYTES,
  FLOOR_BACKGROUND,
  FULL_FIELDS,
  GlobalIncidentError,
  METADATA_FIELDS,
  MailboxUnavailableError,
  NeedsReauthError,
  OAuthError,
  RAW_FIELDS,
  TokenIntegrityError,
  TokenRefreshBusyError,
  UNITS,
  base64ResponseCap,
  decodeRawMessage,
  isGmailError,
  ledgerFailureOutcome,
  MAX_ATTEMPTS,
  metaFromGmailMessage,
  parsedFromGmailPayload,
  quoteAddressForQuery,
  reserveQuota,
  type GmailClient,
} from "@edf/gmail";
import { CryptoConfigError, CryptoError, KeyServiceError } from "@edf/crypto";
import { analyzeMessage, prepareMessage, withoutAnalysisRows, type Prepared } from "./analyze";
import { lookupSender, lookupTemplate, userAddresses } from "./context";
import { gmailClient, killSwitchOn, logOf, mailboxTag, nowOf, type PipelineDeps } from "./deps";
import { raiseAlert } from "./alerts";
import { errorCode } from "./poll";
import { storeQueuedEmail } from "./store/email";

export interface DrainOptions {
  budgetMs: number;
  maxRows: number;
  /** Inline drain for one user (sync-on-open while Inngest is paused, FREE-TIER.md §4.4). */
  userId?: string;
  concurrency?: number;
}

export interface DrainResult {
  processed: number;
  stored: number;
  skipped: number;
  retried: number;
  failed: number;
  deferredMailboxes: number;
  /**
   * "storage": Neon storage is at the governor's ingest pause (≥ 350 MB); "kill_switch": the owner
   * switched ingest off (`kill.ingest`). Nothing was drained in either case.
   */
  stoppedReason: "done" | "deadline" | "global_incident" | "daily_limit" | "database" | "storage" | "kill_switch" | null;
}

interface Row {
  mailbox_id: string;
  user_id: string;
  provider_message_id: string;
  state: "pending" | "pending_full";
  source: string;
  attempts: number;
}

/** The governor's Neon storage stages (FREE-TIER.md §8.3), as stored in `app_setting.governor`. */
export interface StorageGate {
  /** ≥ 300 MB: new emails are stored without analysis rows or search text. */
  noAnalysisRows: boolean;
  /** ≥ 350 MB: ingest pauses, so deletes keep working (Neon rejects even deletes at 500 MB). */
  ingestPaused: boolean;
}

export async function readStorageGate(deps: PipelineDeps): Promise<StorageGate> {
  return withSystem(deps.pool, async (_db, c) => {
    const r = await c.query<{ value: { actions?: Partial<StorageGate> } | null }>(
      "SELECT value FROM app_setting WHERE key = 'governor'",
    );
    const a = r.rows[0]?.value?.actions;
    return { noAnalysisRows: a?.noAnalysisRows === true, ingestPaused: a?.ingestPaused === true };
  });
}

interface MailboxCtx {
  id: string;
  userId: string;
  client: GmailClient;
  addresses: string[];
  deferred: boolean;
}

type Outcome =
  | { kind: "stored" }
  | { kind: "skipped" }
  | { kind: "retry" }
  | { kind: "failed" }
  | { kind: "defer_mailbox"; why: string }
  | { kind: "stop"; why: "global_incident" | "daily_limit" | "database" };

class QuotaDeferred extends Error {
  constructor() {
    super("quota");
    this.name = "QuotaDeferred";
  }
}

async function reserve(deps: PipelineDeps, mb: MailboxCtx, units: number): Promise<void> {
  const r = await withUser(deps.pool, mb.userId, (db) => reserveQuota(db, { mailboxId: mb.id, units, floor: FLOOR_BACKGROUND }));
  if (!r.ok) throw new QuotaDeferred();
}

async function setLedger(
  deps: PipelineDeps,
  row: Row,
  patch:
    | { state: "skipped"; reason: LedgerSkipReason }
    | { state: "failed"; attempts?: number }
    | { state: "retry"; nextAttemptAt: Date | null; attempts: number },
): Promise<void> {
  await withUser(deps.pool, row.user_id, async (_db, c) => {
    if (patch.state === "skipped") {
      await c.query(
        `UPDATE message_ledger SET state = 'skipped', reason = $3, next_attempt_at = NULL, updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2`,
        [row.mailbox_id, row.provider_message_id, patch.reason],
      );
    } else if (patch.state === "failed") {
      // An explicit count (the drain's own) is not bumped again after a claim already counted it.
      await c.query(
        `UPDATE message_ledger SET state = 'failed', attempts = coalesce($3::smallint, attempts + 1), next_attempt_at = NULL, updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2`,
        [row.mailbox_id, row.provider_message_id, patch.attempts ?? null],
      );
    } else {
      await c.query(
        `UPDATE message_ledger SET attempts = $3, next_attempt_at = $4, updated_at = now()
         WHERE mailbox_id = $1 AND provider_message_id = $2`,
        [row.mailbox_id, row.provider_message_id, patch.attempts, patch.nextAttemptAt],
      );
    }
  });
}

/**
 * Mail with HTML longer than this is analysed only after the attempt is recorded ("claimed"):
 * analysis is synchronous CPU, and a step killed mid-analysis (Vercel's 300 s limit) runs neither
 * the store nor the retry bookkeeping. Unclaimed, such a row would stay first in every batch and
 * stall the drain for every mailbox; claimed, it waits out its backoff and is failed after
 * MAX_ATTEMPTS. Static design extraction is bounded (design DECISIONS.md), but the cost of a
 * hostile document is not a function of its size (a 9 KB selector once took minutes), so every
 * HTML email is claimed: one extra ledger write per row, undone when the row is not attempted.
 */
export const CLAIM_HTML_CHARS = 0;

/** Rows whose attempt was recorded before analysis (see CLAIM_HTML_CHARS). */
const claimed = new WeakSet<Row>();

/**
 * Record the attempt before the costly analysis. Returns false when earlier claimed attempts
 * already used up the allowance (each ended without bookkeeping): the row is failed instead.
 */
async function claimAttempt(deps: PipelineDeps, row: Row): Promise<boolean> {
  const attempts = row.attempts + 1;
  if (attempts > MAX_ATTEMPTS + 1) {
    await setLedger(deps, row, { state: "failed", attempts: row.attempts });
    return false;
  }
  const next = ledgerFailureOutcome(Math.min(attempts, MAX_ATTEMPTS), nowOf(deps));
  await setLedger(deps, row, { state: "retry", attempts, nextAttemptAt: next.state === "retry" ? next.nextAttemptAt : null });
  claimed.add(row);
  return true;
}

/** The user has written to this address before (5-unit `in:sent to:` check, DESIGN.md §7.2 step 2). */
async function hasPriorContact(deps: PipelineDeps, mb: MailboxCtx, address: string): Promise<boolean> {
  let quoted: string;
  try {
    quoted = quoteAddressForQuery(address);
  } catch {
    return false; // an address we can't safely quote is treated as "no prior contact"
  }
  await reserve(deps, mb, UNITS.messagesList);
  const res = await mb.client.messagesList({ q: `in:sent to:${quoted}`, maxResults: 1 });
  return (res.messages?.length ?? 0) > 0;
}

/** Fetch the full message: raw (parsed by postal-mime), or format=full + payload adapter when too large. */
async function fetchFull(deps: PipelineDeps, mb: MailboxCtx, id: string): Promise<{ parsed: ParsedEmail; meta: GmailMessageMeta }> {
  await reserve(deps, mb, UNITS.messagesGet);
  try {
    const msg = await mb.client.messagesGet(id, { format: "raw", fields: RAW_FIELDS, maxBytes: base64ResponseCap(DEFAULT_RAW_MAX_BYTES) });
    return { parsed: await parseMime(decodeRawMessage(msg)), meta: metaFromGmailMessage(msg) };
  } catch (err) {
    if (!isGmailError(err, "too_large")) throw err;
  }
  await reserve(deps, mb, UNITS.messagesGet);
  const msg = await mb.client.messagesGet(id, { format: "full", fields: FULL_FIELDS });
  const parsed = await parsedFromGmailPayload(msg, async (attachmentId, opts) => {
    await reserve(deps, mb, UNITS.attachmentsGet);
    return mb.client.attachmentsGet(id, attachmentId, opts);
  });
  return { parsed, meta: metaFromGmailMessage(msg) };
}

function hasListSignals(p: Prepared): boolean {
  const h = p.headers;
  return Boolean(h.listUnsubscribe || h.listId || h.feedbackId || h.espPlatform || h.precedence || h.autoSubmitted);
}

/**
 * Headers alone already prove automated mail (no-reply sender, transactional ESP stream, security
 * or transactional subject from a non-free-mail domain…). The personal override never applies to
 * such mail (DESIGN.md §7.2 step 2), so a password reset from a support address the user once
 * emailed is still fetched and stored.
 */
function hasHeaderHardSignal(parsed: ParsedEmail, meta: GmailMessageMeta, p: Prepared): boolean {
  const v = classifyAutomated({ parsed, headers: p.headers, content: null, labelIds: meta.labelIds, priorContact: null, senderTemplateRepeats: false });
  return (v.hardSignals?.length ?? 0) > 0;
}

async function processRow(deps: PipelineDeps, mb: MailboxCtx, row: Row, storage: StorageGate): Promise<Outcome> {
  const now = nowOf(deps);
  const id = row.provider_message_id;
  let priorContact: boolean | null = null;

  // 1. Metadata-first for non-category mail.
  if (row.state === "pending") {
    await reserve(deps, mb, UNITS.messagesGet);
    const msg = await mb.client.messagesGet(id, { format: "metadata", fields: METADATA_FIELDS });
    const meta = metaFromGmailMessage(msg);
    const headOnly = await parsedFromGmailPayload(msg, async () => new Uint8Array());
    const prep = prepareMessage(headOnly, meta, mb.addresses);
    if (prep.kind === "skip") {
      await setLedger(deps, row, { state: "skipped", reason: prep.reason });
      return { kind: "skipped" };
    }
    if (!hasListSignals(prep.prepared) && !hasHeaderHardSignal(headOnly, meta, prep.prepared) && prep.prepared.fromAddress) {
      priorContact = await hasPriorContact(deps, mb, prep.prepared.fromAddress);
      if (priorContact) {
        await setLedger(deps, row, { state: "skipped", reason: "personal" });
        return { kind: "skipped" };
      }
    }
  }

  // 2. Full fetch + analysis.
  const { parsed, meta } = await fetchFull(deps, mb, id);
  if ((parsed.html?.length ?? 0) > CLAIM_HTML_CHARS && !(await claimAttempt(deps, row))) return { kind: "failed" };
  const prep = prepareMessage(parsed, meta, mb.addresses);
  if (prep.kind === "skip") {
    await setLedger(deps, row, { state: "skipped", reason: prep.reason });
    return { kind: "skipped" };
  }
  const ctx = await withUser(deps.pool, row.user_id, async (_db, c) => {
    const sender = await lookupSender(c, row.user_id, prep.prepared.fromAddress);
    const template = await lookupTemplate(c, sender.senderId, prep.prepared.simhash);
    return { sender, template };
  });
  const analyzeWith = (pc: boolean | null) =>
    analyzeMessage(
      {
        parsed,
        meta,
        mailboxId: row.mailbox_id,
        userId: row.user_id,
        userAddresses: mb.addresses,
        prior: ctx.sender.prior,
        senderBlockedPersonal: ctx.sender.blockedPersonal,
        priorContact: pc,
        template: ctx.template,
        now,
      },
      prep.prepared,
    );
  let result = analyzeWith(priorContact);
  if (result.kind === "store" && result.needsPriorContactCheck && prep.prepared.fromAddress) {
    priorContact = await hasPriorContact(deps, mb, prep.prepared.fromAddress);
    result = analyzeWith(priorContact);
  }
  if (result.kind === "skip") {
    await setLedger(deps, row, { state: "skipped", reason: result.reason });
    return { kind: "skipped" };
  }
  const record = storage.noAnalysisRows ? withoutAnalysisRows(result.record) : result.record;
  const stored = await withUser(deps.pool, row.user_id, (_db, c) => storeQueuedEmail(c, record));
  // Deleted in Gmail while we fetched it (a poll removed its ledger row): nothing to store.
  return stored ? { kind: "stored" } : { kind: "skipped" };
}

function classifyError(err: unknown): Outcome | "retry" | { skip: LedgerSkipReason } {
  if (err instanceof QuotaDeferred) return { kind: "defer_mailbox", why: "quota" };
  if (err instanceof GlobalIncidentError) return { kind: "stop", why: "global_incident" };
  if (err instanceof NeedsReauthError || err instanceof MailboxUnavailableError) return { kind: "defer_mailbox", why: "mailbox" };
  if (err instanceof TokenRefreshBusyError) return { kind: "defer_mailbox", why: "token_busy" };
  // No access token for this mailbox (the refresh or key unwrap failed). That is the mailbox's (or
  // the key service's) problem, not the row's: retrying row by row would burn every row's attempts
  // and cost one edf-keys unwrap plus one Google refresh each, enough to trip edf-keys' rate limit
  // for every user. Defer the mailbox for this run instead; an admin block is not retried at all
  // (FREE-TIER.md §4.8): the mailbox is paused.
  if (err instanceof OAuthError) {
    return { kind: "defer_mailbox", why: err.kind === "admin_policy_enforced" ? "admin_policy" : "token" };
  }
  if (err instanceof KeyServiceError || err instanceof TokenIntegrityError || err instanceof CryptoError || err instanceof CryptoConfigError) {
    return { kind: "defer_mailbox", why: "token" };
  }
  if (err instanceof MimeParseError) return { skip: "parse_error" };
  if (isGmailError(err)) {
    switch (err.kind) {
      case "not_found":
        return { skip: "gmail_error" }; // deleted in Gmail before we got to it
      case "too_large":
        return { skip: "too_large" };
      case "rate_limited":
      case "unauthorized":
        return { kind: "defer_mailbox", why: err.kind };
      case "daily_limit":
        return { kind: "stop", why: "daily_limit" };
      case "policy":
        return { kind: "defer_mailbox", why: "policy" };
      default:
        return "retry";
    }
  }
  if (isDatabaseUnavailable(err)) return { kind: "stop", why: "database" };
  return "retry";
}

async function pauseForPolicy(deps: PipelineDeps, mb: MailboxCtx, reason: "domain_policy" | "admin_policy"): Promise<void> {
  await withUser(deps.pool, mb.userId, (_db, c: PoolClient) =>
    c.query(`UPDATE mailbox SET status = 'paused', status_reason = $2, updated_at = now() WHERE id = $1 AND status = 'active'`, [mb.id, reason]),
  );
}

async function recordTokenFailure(deps: PipelineDeps, err: unknown): Promise<void> {
  await withSystem(deps.pool, (_db, c) =>
    c.query("INSERT INTO app_error (job, code, detail_code) VALUES ('drain', $1, 'token_deferred')", [errorCode(err)]),
  ).catch(() => {});
}

export async function drain(deps: PipelineDeps, opts: DrainOptions): Promise<DrainResult> {
  const log = logOf(deps);
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  const out: DrainResult = { processed: 0, stored: 0, skipped: 0, retried: 0, failed: 0, deferredMailboxes: 0, stoppedReason: null };

  // Neon storage at the ingest pause: leave every row queued (nothing is fetched or written), so
  // the database stays below the size where Neon rejects even the deletes that would free it.
  const storage = await readStorageGate(deps);
  if (storage.ingestPaused) {
    out.stoppedReason = "storage";
    log("drain.done", { processed: 0, reason: "storage", ms: Date.now() - started });
    return out;
  }
  // The owner's emergency stop for ingest: every row stays queued until it is switched back on.
  if (await killSwitchOn(deps.pool, "ingest")) {
    out.stoppedReason = "kill_switch";
    log("drain.done", { processed: 0, reason: "kill_switch", ms: Date.now() - started });
    return out;
  }

  // One user's drain (sync on open) reads the whole due batch before filtering: limited to
  // `maxRows` first, other mailboxes' rows would fill it and leave this user's rows out.
  const rows = await withSystem(deps.pool, async (_db, c) => {
    const r = opts.userId
      ? await c.query<Row>("SELECT * FROM list_drain_batch(2000) WHERE user_id = $1 LIMIT $2", [opts.userId, Math.min(opts.maxRows, 2000)])
      : await c.query<Row>("SELECT * FROM list_drain_batch($1)", [Math.min(opts.maxRows, 2000)]);
    return r.rows;
  });
  if (rows.length === 0) {
    out.stoppedReason = "done";
    return out;
  }

  const mailboxes = new Map<string, MailboxCtx>();
  const ctxFor = async (row: Row): Promise<MailboxCtx> => {
    let mb = mailboxes.get(row.mailbox_id);
    if (!mb) {
      const addresses = await withUser(deps.pool, row.user_id, (_db, c) => userAddresses(c, row.user_id));
      mb = { id: row.mailbox_id, userId: row.user_id, client: gmailClient(deps, row.user_id, row.mailbox_id), addresses, deferred: false };
      mailboxes.set(row.mailbox_id, mb);
    }
    return mb;
  };

  let cursor = 0;
  let stop: DrainResult["stoppedReason"] = null;
  const worker = async (): Promise<void> => {
    while (stop === null) {
      if (Date.now() > deadline - 5_000) {
        stop = "deadline";
        return;
      }
      const row = rows[cursor++];
      if (!row) return;
      const mb = await ctxFor(row);
      if (mb.deferred) continue;
      let outcome: Outcome;
      let failure: unknown = null;
      try {
        outcome = await processRow(deps, mb, row, storage);
      } catch (err) {
        failure = err;
        const c = classifyError(err);
        if (c === "retry") {
          const attempts = row.attempts + 1;
          const next = ledgerFailureOutcome(attempts, nowOf(deps));
          try {
            await setLedger(deps, row, next.state === "failed" ? { state: "failed", attempts } : { state: "retry", nextAttemptAt: next.nextAttemptAt, attempts });
          } catch (e2) {
            if (isDatabaseUnavailable(e2)) stop = "database";
          }
          outcome = next.state === "failed" ? { kind: "failed" } : { kind: "retry" };
        } else if ("skip" in c) {
          await setLedger(deps, row, { state: "skipped", reason: c.skip }).catch(() => {});
          outcome = { kind: "skipped" };
        } else {
          outcome = c;
        }
      }
      // Not attempted after all (mailbox deferred, run stopped): undo the claim, so the row stays
      // eligible and no attempt is counted.
      if ((outcome.kind === "defer_mailbox" || outcome.kind === "stop") && claimed.has(row)) {
        await setLedger(deps, row, { state: "retry", attempts: row.attempts, nextAttemptAt: null }).catch(() => {});
      }
      out.processed++;
      switch (outcome.kind) {
        case "stored":
          out.stored++;
          break;
        case "skipped":
          out.skipped++;
          break;
        case "retry":
          out.retried++;
          break;
        case "failed":
          out.failed++;
          break;
        case "defer_mailbox":
          out.processed--; // not attempted: stays pending, no attempt counted
          if (!mb.deferred) {
            mb.deferred = true;
            out.deferredMailboxes++;
            if (outcome.why === "policy") await pauseForPolicy(deps, mb, "domain_policy").catch(() => {});
            if (outcome.why === "admin_policy") await pauseForPolicy(deps, mb, "admin_policy").catch(() => {});
            // Rows no longer burn attempts on a token failure, so a token that stays broken would
            // otherwise go unnoticed: leave one content-free app_error per mailbox per run (System page).
            if (outcome.why === "token") await recordTokenFailure(deps, failure);
            log("drain.mailbox_deferred", { mailbox: mailboxTag(mb.id), why: outcome.why });
          }
          break;
        case "stop":
          out.processed--;
          stop = outcome.why;
          if (outcome.why === "global_incident") {
            await raiseAlert(deps.pool, deps.alerts ?? { token: undefined, repo: undefined }, "GLOBAL_OAUTH_INCIDENT").catch(() => {});
          }
          return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, 8)) }, () => worker()));
  out.stoppedReason = stop ?? "done";
  log("drain.done", {
    processed: out.processed,
    stored: out.stored,
    skipped: out.skipped,
    retried: out.retried,
    failed: out.failed,
    reason: out.stoppedReason,
    ms: Date.now() - started,
  });
  return out;
}
