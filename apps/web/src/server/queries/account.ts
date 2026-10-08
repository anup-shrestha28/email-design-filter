/** Today view, sync status, settings (FREE-TIER.md §0 "in-app Today view", §4.4; DESIGN.md §9.5). */
import "server-only";
import { sql } from "@edf/db";
import { raw } from "@edf/db";
import { withUser, type Db } from "@edf/db";
import type { EmailType, TypeGroup } from "@edf/core/types";
import { typeGroupOf } from "@/lib/types-display";
import { env } from "@/env";
import { getPool } from "../db";
import { imagesClickToLoad } from "../image-switch";
import type { SessionUser } from "../session";
import { INBOX_COLUMNS, toInboxItem, type InboxRow } from "./inbox";
import type { MailboxInfo, SettingsData, SyncStatus, TodayData } from "./types";

/** timestamptz → ISO string; null for NULL and ±infinity (node-postgres returns those as ±Infinity). */
function iso(d: Date | number | null): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

async function mailboxInfos(db: Db, userId: string): Promise<MailboxInfo[]> {
  const res = await raw(db).execute<{
    id: string; email_address: string; status: MailboxInfo["status"]; status_reason: string | null;
    last_synced_at: Date | null; next_poll_at: Date | number | null; backfill_state: MailboxInfo["backfill"]["state"];
    backfill_progress: { listed?: number; windowDays?: number } | null; backfill_window_days: number;
    resync_pending: boolean; pending: string; stored: string; skipped: string; failed: string;
    backfill_requested_at: Date | null;
  }>(sql`
    SELECT m.id, m.email_address::text AS email_address, m.status, m.status_reason, m.last_synced_at, m.next_poll_at,
           m.backfill_state, m.backfill_progress, coalesce(us.backfill_window_days, 90) AS backfill_window_days,
           m.resync_pending, m.backfill_requested_at,
           count(l.*) FILTER (WHERE l.state IN ('pending', 'pending_full')) AS pending,
           count(l.*) FILTER (WHERE l.state = 'stored') AS stored,
           count(l.*) FILTER (WHERE l.state = 'skipped') AS skipped,
           count(l.*) FILTER (WHERE l.state = 'failed') AS failed
    FROM mailbox m
    LEFT JOIN user_settings us ON us.user_id = m.user_id
    LEFT JOIN message_ledger l ON l.mailbox_id = m.id AND l.user_id = m.user_id
    WHERE m.user_id = ${userId} AND m.status <> 'connecting'
    GROUP BY m.id, us.backfill_window_days
    ORDER BY m.created_at`);
  const queue = res.rows.some((r) => r.backfill_state === "pending")
    ? await raw(db).execute<{ mailbox_id: string; rn: string }>(sql`
        SELECT q.mailbox_id, q.rn FROM list_backfill_queue(100)
          WITH ORDINALITY AS q(mailbox_id, user_id, backfill_state, requested_at, rn)`)
    : { rows: [] as Array<{ mailbox_id: string; rn: string }> };
  return res.rows.map((r) => {
    const pos = queue.rows.find((q) => q.mailbox_id === r.id);
    return {
      id: r.id,
      emailAddress: r.email_address,
      status: r.status,
      statusReason: r.status_reason,
      lastSyncedAt: iso(r.last_synced_at),
      nextPollAt: iso(r.next_poll_at), // 'infinity' = never polled (e.g. development fixture mailboxes)
      backfill: {
        state: r.backfill_state,
        windowDays: r.backfill_progress?.windowDays ?? r.backfill_window_days,
        listed: r.backfill_progress?.listed ?? 0,
        stored: Number(r.stored),
        queuedPosition: r.backfill_state === "pending" && pos ? Number(pos.rn) : null,
      },
      health: { pending: Number(r.pending), stored: Number(r.stored), skipped: Number(r.skipped), failed: Number(r.failed) },
      resyncPending: r.resync_pending,
    };
  });
}

/** The app-wide state behind the banners of FREE-TIER.md §8.2–8.3 (every level shows one, §1.3 rule 3). */
export interface SystemBannerState {
  /** The governor level the system is acting on (`app_setting.governor`). */
  level: number;
  /** `system_state.inngest_paused`: background jobs stopped (§4.9 Plan B keeps mail flowing on open). */
  inngestPaused: boolean;
  /** `app_setting.ai.paused` (an admin banner, §6: the owner only). */
  aiPaused: boolean;
  /** The owner's emergency stop for new mail (`kill.ingest`). */
  ingestKilled: boolean;
  role: "owner" | "friend" | null;
  tickEvery: 30 | 60;
  /** The governor's image switch is on for this user (server/image-switch.ts): cards come without pictures. */
  picturesPaused: boolean;
  /** The daily picture check's last result (`app_setting.picture_health`, server/picture-health.ts). */
  pictureCheck: { ok: boolean; checkedAt: string | null; problems: Array<{ role: string; code: string }> } | null;
}

/** Plain words for the daily picture check's problem codes (server/picture-health.ts). */
const PICTURE_PROBLEM_WORDS: Record<string, string> = {
  paused: "pictures are paused to stay within the free limits",
  no_picture_links: "cards are being built without their pictures",
  card_failed: "gallery cards didn't load",
  pictures_not_served: "the picture service isn't sending pictures",
};
/** A failed check is shown until the next one, but never for longer than this. */
const PICTURE_CHECK_SHOWN_MS = 36 * 3600 * 1000;

type Banner = NonNullable<SyncStatus["banner"]>;

/** The app-wide banners, most severe first (each id names its situation, so dismissals stick). */
function systemBanners(s: SystemBannerState): { frozen: Banner | null; warnings: Banner[]; saver: Banner | null } {
  const frozen: Banner | null =
    s.level >= 3
      ? {
          id: "governor:3",
          level: "error",
          text: "Frozen to stay within the free limits: new mail, design renders and AI reviews are paused until usage drops. Your stored mail stays readable, and export, delete and disconnect still work.",
        }
      : null;
  const warnings: Banner[] = [];
  if (s.picturesPaused) {
    warnings.push({
      id: "pictures:paused",
      level: "warning",
      text: "Pictures are paused to stay within the free limits, so designs show without them for now. Open a design and press Load images to see its pictures. They come back on their own when usage drops.",
    });
  }
  const check = s.pictureCheck;
  const realProblems = (check?.problems ?? []).filter((p) => p.code !== "paused" || !s.picturesPaused);
  if (
    s.role === "owner" &&
    check &&
    !check.ok &&
    check.checkedAt !== null &&
    Date.now() - Date.parse(check.checkedAt) < PICTURE_CHECK_SHOWN_MS &&
    realProblems.length > 0
  ) {
    const p = realProblems[0]!;
    const who = p.role === "owner" ? "your gallery" : "a friend's gallery";
    warnings.push({
      id: `pictures:check:${check.checkedAt}`,
      level: "warning",
      text: `Today's picture check found a problem in ${who}: ${PICTURE_PROBLEM_WORDS[p.code] ?? "pictures didn't load"}. Your designs are safe; ask Claude to look at it.`,
    });
  }
  if (s.ingestKilled) {
    warnings.push({ id: "kill:ingest", level: "warning", text: "New mail is paused for now. It resumes when the app's owner turns it back on." });
  }
  if (s.inngestPaused) {
    warnings.push({
      id: "inngest:paused",
      level: "warning",
      text: "Background sync is paused. New mail still arrives while the app is open; imports, design renders and AI reviews wait until it resumes.",
    });
  }
  if (s.level === 2) {
    warnings.push({
      id: "governor:2",
      level: "warning",
      text: "Essentials mode to stay within the free limits: new mail every 6 hours (sooner when you open the app); planned design renders and automatic AI reviews are paused.",
    });
  }
  if (s.aiPaused && s.role === "owner") {
    warnings.push({ id: "ai:paused", level: "warning", text: "AI reviews are paused (the Claude spend limit was reached). Design scores still work; see the System page." });
  }
  const saver: Banner | null =
    s.level === 1
      ? {
          id: "governor:1",
          level: "info",
          text: `Saver mode to stay within the free limits: new mail every ${s.tickEvery * 2} min (sooner when you open the app); fill-in design renders are paused.`,
        }
      : null;
  return { frozen, warnings, saver };
}

/**
 * The one banner the shell shows: the most severe of the app-wide state (governor level, paused
 * background jobs, paused AI, owner switches) and this user's mailboxes.
 */
export function syncBanner(mailboxes: MailboxInfo[], system?: SystemBannerState): SyncStatus["banner"] {
  const sys = system ? systemBanners(system) : { frozen: null, warnings: [], saver: null };
  if (sys.frozen) return sys.frozen;
  const reauth = mailboxes.find((m) => m.status === "needs_reauth");
  if (reauth) return { id: `reauth:${reauth.id}`, level: "error", text: `Reconnect ${reauth.emailAddress}: Google access expired or was revoked.` };
  // Severity first: an app-wide warning outranks the (info) connect prompt, which /today and
  // /connect carry as their own call to action anyway, so nothing there hides the warning.
  if (sys.warnings[0]) return sys.warnings[0];
  if (mailboxes.length === 0) return { id: "connect", level: "info", text: "Connect your Gmail to get started." };
  const paused = mailboxes.find((m) => m.status === "paused");
  if (paused) return { id: `paused:${paused.id}`, level: "warning", text: `${paused.emailAddress} is paused by a Google policy.` };
  if (sys.saver) return sys.saver;
  const running = mailboxes.find((m) => m.backfill.state === "running");
  if (running) return { id: `import:${running.id}`, level: "info", text: `Importing ${running.emailAddress}: ${running.backfill.stored.toLocaleString()} emails so far.` };
  const queued = mailboxes.find((m) => m.backfill.queuedPosition !== null);
  if (queued) return { id: `queued:${queued.id}`, level: "info", text: `Import queued (position ${queued.backfill.queuedPosition}).` };
  return null;
}

export async function getSyncStatus(userId: string): Promise<SyncStatus> {
  const pool = await getPool();
  const { mailboxes, pollingOff, system } = await withUser(pool, userId, async (db) => {
    const st = await raw(db).execute<{
      governor: { level?: number; actions?: { syncStatusPollingOff?: boolean; imagesClickToLoad?: boolean; friendsImagesClickToLoad?: boolean } } | null;
      picture_health: SystemBannerState["pictureCheck"];
      ai_paused: { paused?: boolean } | null;
      kill_ingest: unknown;
      inngest_paused: boolean | null;
      role: "owner" | "friend" | null;
    }>(sql`
      SELECT (SELECT value FROM app_setting WHERE key = 'governor') AS governor,
             (SELECT value FROM app_setting WHERE key = 'picture_health') AS picture_health,
             (SELECT value FROM app_setting WHERE key = 'ai.paused') AS ai_paused,
             (SELECT value FROM app_setting WHERE key = 'kill.ingest') AS kill_ingest,
             (SELECT inngest_paused FROM system_state) AS inngest_paused,
             (SELECT role FROM user_settings WHERE user_id = ${userId}) AS role`);
    const r = st.rows[0];
    const v = r?.governor;
    const level = Number(v?.level ?? 0) || 0;
    const system: SystemBannerState = {
      level,
      inngestPaused: r?.inngest_paused === true,
      aiPaused: r?.ai_paused?.paused === true,
      ingestKilled: r?.kill_ingest === true,
      role: r?.role ?? null,
      tickEvery: env().TICK_EVERY === "60" ? 60 : 30,
      picturesPaused: imagesClickToLoad(v ?? null, r?.role === "owner" ? "owner" : "friend"),
      pictureCheck: r?.picture_health ?? null,
    };
    // L1 and up (FREE-TIER.md §8.2): the page stops re-checking sync status on a timer.
    return {
      mailboxes: await mailboxInfos(db, userId),
      pollingOff: v?.actions?.syncStatusPollingOff === true || level >= 1,
      system,
    };
  });
  const last = mailboxes
    .map((m) => m.lastSyncedAt)
    .filter((x): x is string => x !== null)
    .sort()
    .at(-1) ?? null;
  return {
    mailboxes,
    syncing: mailboxes.some((m) => m.health.pending > 0 || m.backfill.state === "running"),
    lastSyncedAt: last,
    banner: syncBanner(mailboxes, system),
    pollingOff,
  };
}

export async function getToday(user: SessionUser): Promise<TodayData> {
  const pool = await getPool();
  const now = new Date();
  const sync = await getSyncStatus(user.userId);
  const data = await withUser(pool, user.userId, async (db) => {
    const base = sql`FROM email e LEFT JOIN sender s ON s.id = e.sender_id AND s.user_id = e.user_id
                     WHERE e.user_id = ${user.userId} AND NOT e.is_hidden`;
    const attention = await raw(db).execute<InboxRow>(sql`
      SELECT ${INBOX_COLUMNS} ${base} AND e.importance = 'high' AND e.done_at IS NULL
        AND ((e.is_unread AND e.opened_in_app_at IS NULL) OR e.received_at > now() - interval '14 days')
      ORDER BY e.received_at DESC LIMIT 8`);
    const deals = await raw(db).execute<InboxRow>(sql`
      SELECT ${INBOX_COLUMNS} ${base} AND e.has_deal AND e.deal_ends_at > now() AND e.deal_ends_at <= now() + interval '48 hours'
      ORDER BY e.deal_ends_at ASC LIMIT 6`);
    const last24 = await raw(db).execute<{ primary_type: EmailType; n: string }>(sql`
      SELECT e.primary_type, count(*) AS n ${base} AND e.received_at > now() - interval '24 hours' GROUP BY 1`);
    const settings = await raw(db).execute<{ last_active_at: Date | null }>(sql`
      SELECT last_active_at FROM user_settings WHERE user_id = ${user.userId}`);
    const lastVisit = settings.rows[0]?.last_active_at ?? null;
    const fresh = await raw(db).execute<{ n: string }>(sql`
      SELECT count(*) AS n ${base} AND e.created_at > ${lastVisit ?? new Date(0)}`);
    const best = await raw(db).execute<InboxRow>(sql`
      SELECT ${INBOX_COLUMNS} ${base} AND e.received_at > now() - interval '7 days' AND e.design_score IS NOT NULL
        AND e.design_provisional IS NOT TRUE ORDER BY e.design_score DESC, e.received_at DESC LIMIT 1`);
    const worst = await raw(db).execute<InboxRow>(sql`
      SELECT ${INBOX_COLUMNS} ${base} AND e.received_at > now() - interval '7 days' AND e.design_score IS NOT NULL
        AND e.design_provisional IS NOT TRUE ORDER BY e.design_score ASC, e.received_at DESC LIMIT 1`);
    const aiPending = await raw(db).execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM email WHERE user_id = ${user.userId} AND design_source = 'render' AND design_ai_state IN ('pending', 'queued')`);
    return { attention, deals, last24, fresh, best, worst, aiPending };
  });
  const byGroup: Partial<Record<TypeGroup, number>> = {};
  let total = 0;
  for (const r of data.last24.rows) {
    const g = typeGroupOf(r.primary_type);
    byGroup[g] = (byGroup[g] ?? 0) + Number(r.n);
    total += Number(r.n);
  }
  const best = data.best.rows[0];
  const worst = data.worst.rows[0];
  return {
    firstName: user.name.split(/\s+/)[0] || "there",
    sync,
    needsAttention: data.attention.rows.map((r) => toInboxItem(r, now)),
    dealsEndingSoon: data.deals.rows.map((r) => toInboxItem(r, now)),
    newSinceLastVisit: Number(data.fresh.rows[0]?.n ?? 0),
    last24h: { total, byGroup },
    designHighlights: {
      best: best ? toInboxItem(best, now) : null,
      worst: worst && worst.id !== best?.id ? toInboxItem(worst, now) : null,
    },
    aiPendingCount: Number(data.aiPending.rows[0]?.n ?? 0),
  };
}

export async function getSettings(user: SessionUser): Promise<SettingsData> {
  const pool = await getPool();
  return withUser(pool, user.userId, async (db, client) => {
    const s = await raw(db).execute<{
      timezone: string; load_images_for_analysis: boolean; link_check_opt_in: boolean;
      backfill_window_days: 30 | 90 | 180; ai_processing_consent_at: Date | null;
    }>(sql`SELECT timezone, load_images_for_analysis, link_check_opt_in, backfill_window_days, ai_processing_consent_at
           FROM user_settings WHERE user_id = ${user.userId}`);
    const mailboxes = await mailboxInfos(db, user.userId);
    const spend = await raw(db).execute<{ month: string | null; day: string | null }>(sql`
      SELECT sum(reserved_usd) FILTER (WHERE scope = 'month' AND day = date_trunc('month', now())::date) AS month,
             sum(reserved_usd) FILTER (WHERE scope = 'day' AND day = current_date) AS day
      FROM llm_budget WHERE user_id = ${user.userId}`);
    let invites: SettingsData["invites"] = null;
    if (user.role === "owner") {
      const r = await client.query<{ email: string; role: "owner" | "friend"; created_at: Date; used_at: Date | null }>(
        "SELECT email, role, created_at, used_at FROM list_invites()",
      );
      invites = r.rows.map((i) => ({
        email: i.email,
        role: i.role,
        createdAt: i.created_at.toISOString(),
        usedAt: i.used_at?.toISOString() ?? null,
      }));
    }
    const accounts = await client.query<{ n: string }>("SELECT count(*) AS n FROM oauth_subject_seen");
    const setting = s.rows[0];
    const capSetting = await client.query<{ value: unknown }>("SELECT value FROM app_setting WHERE key = 'ai.cap_usd'");
    const G = Number(capSetting.rows[0]?.value ?? 5) || 5;
    const monthCap = user.role === "owner" ? 0.9 * G : 0.5 * (G / 5);
    const dayCap = user.role === "owner" ? 0.5 : 0.1 * (G / 5);
    return {
      user: { name: user.name, email: user.email, role: user.role, image: user.image },
      settings: {
        timezone: setting?.timezone ?? "UTC",
        loadImagesForAnalysis: setting?.load_images_for_analysis ?? true,
        linkCheckOptIn: setting?.link_check_opt_in ?? false,
        backfillWindowDays: setting?.backfill_window_days ?? 90,
        aiProcessingConsentAt: setting?.ai_processing_consent_at?.toISOString() ?? null,
      },
      mailboxes,
      ai: {
        spentThisMonthUsd: Number(spend.rows[0]?.month ?? 0),
        monthCapUsd: Math.round(monthCap * 100) / 100,
        dayCapUsd: Math.round(dayCap * 100) / 100,
      },
      invites,
      googleAccountsUsed: Number(accounts.rows[0]?.n ?? 0),
    };
  });
}
