/**
 * Out-of-band alerts (FREE-TIER.md §8.5): one GitHub issue per alert code on the owner's private
 * repo, opened or updated with a fine-grained token scoped to Issues: write. GitHub emails the owner.
 * Content: codes and counts only — never addresses, subjects or any email content.
 * A code is re-notified at most once every 6 hours (tracked in app_setting "alerts.sent"). The
 * mark is taken before the GitHub call (so concurrent raisers don't both send) and given back if
 * that call fails, so the next raise tries again instead of the alert being lost for 6 hours.
 */
import { withSystem, type pg } from "@edf/db";

export type AlertCode =
  | "GOVERNOR_LEVEL"
  | "SET_TICK_EVERY_60"
  | "INNGEST_PAUSED"
  | "STALE_TICK"
  | "STALE_MAINTENANCE"
  | "STALE_RENDER_BATCH"
  | "AI_PAUSED"
  | "L3_FROZEN"
  | "SIGNIN_BREAKER"
  | "EXTERNAL_LOAD_SPIKE"
  | "GOOGLE_ACCOUNTS_70"
  | "GLOBAL_OAUTH_INCIDENT"
  | "EXECUTION_TRIPWIRE";

export interface AlertConfig {
  token: string | undefined;
  /** "owner/repo" */
  repo: string | undefined;
  fetchImpl?: typeof fetch;
}

const RENOTIFY_MS = 6 * 60 * 60 * 1000;
const LABEL = "edf-alert";

function assertContentFree(details: Record<string, string | number | boolean>): void {
  for (const [k, v] of Object.entries(details)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) throw new Error("alert detail keys must be simple codes");
    if (typeof v === "string" && (!/^[A-Za-z0-9_.:+-]{0,64}$/.test(v) || v.includes("@"))) {
      throw new Error("alert details must be codes or numbers only");
    }
  }
}

/** Give back a send mark taken by `raiseAlert` (only if no later raise replaced it). */
async function releaseMark(pool: pg.Pool, code: AlertCode, mark: string, before: string | undefined): Promise<void> {
  await withSystem(pool, async (_db, c) => {
    const r = await c.query<{ value: Record<string, string> }>("SELECT value FROM app_setting WHERE key = 'alerts.sent' FOR UPDATE");
    const sent = { ...(r.rows[0]?.value ?? {}) };
    if (sent[code] !== mark) return;
    if (before === undefined) delete sent[code];
    else sent[code] = before;
    await c.query("UPDATE app_setting SET value = $1, updated_at = now() WHERE key = 'alerts.sent'", [JSON.stringify(sent)]);
  });
}

/**
 * Raise (or refresh) an alert. Never throws: alerting must not break the job that raises it.
 * Returns true when GitHub was notified.
 */
export async function raiseAlert(
  pool: pg.Pool,
  cfg: AlertConfig,
  code: AlertCode,
  details: Record<string, string | number | boolean> = {},
  now = new Date(),
): Promise<boolean> {
  let taken: { mark: string; before: string | undefined } | null = null;
  try {
    assertContentFree(details);
    if (!cfg.token || !cfg.repo) return false;
    taken = await withSystem(pool, async (_db, c) => {
      const r = await c.query<{ value: Record<string, string> }>("SELECT value FROM app_setting WHERE key = 'alerts.sent' FOR UPDATE");
      const sent = r.rows[0]?.value ?? {};
      const last = sent[code] ? Date.parse(sent[code]) : 0;
      if (now.getTime() - last < RENOTIFY_MS) return null;
      const next = { ...sent, [code]: now.toISOString() };
      if (r.rowCount) await c.query("UPDATE app_setting SET value = $1, updated_at = now() WHERE key = 'alerts.sent'", [JSON.stringify(next)]);
      return { mark: now.toISOString(), before: sent[code] };
    });
    if (!taken) return false;
    const f = cfg.fetchImpl ?? fetch;
    const headers = {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "edf-alerts",
    };
    const title = `[edf-alert] ${code}`;
    const body = [
      `**${code}** at ${now.toISOString()}`,
      "",
      ...Object.entries(details).map(([k, v]) => `- ${k}: ${String(v)}`),
      "",
      "_Codes and counts only. Open the System page for details._",
    ].join("\n");
    const q = encodeURIComponent(`repo:${cfg.repo} is:issue is:open label:${LABEL} in:title "${title}"`);
    const search = await f(`https://api.github.com/search/issues?q=${q}&per_page=1`, { headers, signal: AbortSignal.timeout(8000) });
    const found = search.ok ? ((await search.json()) as { items?: Array<{ number: number }> }).items?.[0] : undefined;
    const res = found
      ? await f(`https://api.github.com/repos/${cfg.repo}/issues/${found.number}/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
          signal: AbortSignal.timeout(8000),
        })
      : await f(`https://api.github.com/repos/${cfg.repo}/issues`, {
          method: "POST",
          headers,
          body: JSON.stringify({ title, body, labels: [LABEL] }),
          signal: AbortSignal.timeout(8000),
        });
    if (!res.ok) throw new Error("github_alert_failed");
    return true;
  } catch {
    if (taken) await releaseMark(pool, code, taken.mark, taken.before).catch(() => {});
    return false;
  }
}
