import "server-only";
/**
 * The daily picture check (2026-10-08). Gallery pictures had silently gone missing three ways: a
 * governor switch minted every card without pictures, a privacy rule dropped one sender's image
 * CDN, and oversized pictures stalled in the browser. Each time the owner found out from a
 * screenshot. Once a day this does what a browser does, for every user with a gallery:
 *
 *  1. asks for a card link exactly as the gallery would (same access rules and image switch);
 *  2. loads that card from edf-view, the way the card's frame does, and finds its picture links;
 *  3. downloads up to two of those pictures from edf-view and checks they really are pictures
 *     (not the "Picture unavailable" placeholder, not an error page).
 *
 * The result goes to `app_setting.picture_health`; when anything failed, the owner sees a banner
 * (queries/account.ts) and the PICTURES_BROKEN alert is raised. Content-free: codes and counts only,
 * never addresses, subjects or picture URLs.
 */
import { withSystem, withUser } from "@edf/db";
import { env } from "@/env";
import { getPool } from "./db";
import { previewAccess } from "./queries/gallery";
import { viewerUrl } from "./viewer-urls";

export type PictureProblem =
  /** The governor's image switch is on for this user: cards are built without pictures. */
  | "paused"
  /** The card loaded but carried no picture links, though the email has pictures. */
  | "no_picture_links"
  /** The card itself didn't load from edf-view. */
  | "card_failed"
  /** Picture links were there but edf-view served no real picture for them. */
  | "pictures_not_served";

export interface PictureHealth {
  ok: boolean;
  checkedAt: string;
  /** Users with a gallery email that has pictures, checked end to end. */
  checked: number;
  problems: Array<{ role: "owner" | "friend"; code: PictureProblem }>;
}

/** Newest analysed emails that have content pictures; the gallery's own rules then pick one. */
const CANDIDATES = 20;
const FETCH_TIMEOUT_MS = 20_000;
/** The whole check stays well inside the daily cron's budget; users left over wait a day. */
const CHECK_BUDGET_MS = 120_000;
/** Cards tried per user before reporting a problem. */
const TRIES = 3;

async function fetchWithTimeout(url: string): Promise<Response | null> {
  try {
    return await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" });
  } catch {
    return null;
  }
}

/** Picture links (edf-view /img/ tokens) in a card's HTML, in order, without the placeholder. */
export function pictureLinks(html: string, viewOrigin: string): string[] {
  const prefix = `${viewOrigin.replace(/\/$/, "")}/img/`;
  const out: string[] = [];
  for (const m of html.matchAll(/\ssrc="([^"]+)"/g)) {
    const src = (m[1] ?? "").replaceAll("&amp;", "&");
    if (src.startsWith(prefix) && !src.startsWith(`${prefix}unavailable`) && !out.includes(src)) out.push(src);
  }
  return out;
}

export async function checkUserPictures(
  userId: string,
  role: "owner" | "friend",
  viewOrigin: string,
  deadline: number,
): Promise<PictureProblem | "none" | null> {
  const pool = await getPool();
  const candidates = await withUser(pool, userId, async (_db, c) =>
    (
      await c.query<{ id: string }>(
        `SELECT e.id FROM email e JOIN email_analysis a ON a.email_id = e.id
          WHERE e.user_id = $1 AND e.design_status = 'done'
            AND coalesce((a.features #>> '{static,images,content}')::int, 0) > 0
          ORDER BY e.received_at DESC LIMIT ${CANDIDATES}`,
        [userId],
      )
    ).rows.map((r) => r.id),
  );
  if (candidates.length === 0) return null;
  const access = await previewAccess(userId, role, candidates);
  const shown = candidates.filter((id) => access.ids.includes(id));
  if (shown.length === 0) return null; // nothing the gallery shows has pictures: nothing to check
  if (access.imagesOff) return "paused";
  // Up to three emails: one sender's pictures can be legitimately unavailable (all of them on a
  // tracker host, say); the check fails only when none of the three shows a real picture.
  let first: PictureProblem | null = null;
  for (const [i, emailId] of shown.slice(0, TRIES).entries()) {
    if (i > 0 && Date.now() > deadline) break; // out of time: report what was seen
    const r = await checkCard(userId, emailId, viewOrigin);
    if (r === "none") return "none";
    first ??= r;
  }
  return first;
}

async function checkCard(userId: string, emailId: string, viewOrigin: string): Promise<PictureProblem | "none"> {
  const card = await fetchWithTimeout(viewerUrl(userId, emailId, "card"));
  if (!card || card.status !== 200) {
    await card?.body?.cancel().catch(() => undefined);
    return "card_failed";
  }
  const links = pictureLinks(await card.text(), viewOrigin);
  if (links.length === 0) return "no_picture_links";
  for (const link of links.slice(0, 2)) {
    const r = await fetchWithTimeout(link);
    const type = r?.headers.get("content-type") ?? "";
    await r?.body?.cancel().catch(() => undefined);
    if (r && r.status === 200 && type.startsWith("image/") && type !== "image/svg+xml") return "none";
  }
  return "pictures_not_served";
}

/** Run the check for every user and store the result in `app_setting.picture_health`. */
export async function checkPictureHealth(): Promise<PictureHealth> {
  const pool = await getPool();
  const viewOrigin = env().VIEW_ORIGIN.replace(/\/$/, "");
  const users = await withSystem(pool, async (_db, c) =>
    (await c.query<{ user_id: string; role: string }>("SELECT user_id, role FROM list_active_users()")).rows,
  );
  const problems: PictureHealth["problems"] = [];
  let checked = 0;
  const started = Date.now();
  for (const u of users) {
    if (Date.now() - started > CHECK_BUDGET_MS) break;
    const role = u.role === "owner" ? "owner" : "friend";
    let result: PictureProblem | "none" | null;
    try {
      result = await checkUserPictures(u.user_id, role, viewOrigin, started + CHECK_BUDGET_MS);
    } catch {
      result = "card_failed";
    }
    if (result === null) continue;
    checked++;
    if (result !== "none") problems.push({ role, code: result });
  }
  const health: PictureHealth = { ok: problems.length === 0, checkedAt: new Date().toISOString(), checked, problems };
  await withSystem(pool, async (_db, c) => {
    await c.query(
      // The row is seeded by migration 0019 (app_rw may update settings, not add them).
      "UPDATE app_setting SET value = $1::jsonb, updated_at = now() WHERE key = 'picture_health'",
      [JSON.stringify(health)],
    );
  });
  console.info("[edf] picture_health", { ok: health.ok, checked, problems: problems.map((p) => `${p.role}:${p.code}`).join(",") });
  return health;
}
