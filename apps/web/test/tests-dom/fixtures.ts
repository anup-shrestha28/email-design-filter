/**
 * Shared arrangements for the component tests: accounts with a mailbox, emails in each design
 * state (stored through the real pipeline store), the governor row, and the Actions the email page
 * computes (the real getEmailDetail query), so components render exactly what the page would pass.
 */
import { SCORING_VERSION, type ScoreSummary } from "@edf/design";
import { withUser, type pg } from "@edf/db";
import type { EmailRecord } from "@edf/pipeline";
import type { EmailDetail } from "@/server/queries/types";
import type { SessionUser } from "@/server/session";
import { createMailbox, createUser, emailRecord, seedEmail } from "../support/db";

export const FRIENDS = /renders for friends are paused/;
export const EVERYONE = /paused for everyone/;
/** The Sandbox self-cap: friends' on-demand renders pause, the owner's still run. */
export const SELF_CAP = { level: 0, actions: { plannedRendersOff: true, samplesOff: true, fillRendersOff: true } };
/** Static-only: nobody's renders run. */
export const STATIC_ONLY = { level: 0, actions: { rendersOff: true, plannedRendersOff: true } };

export interface Account {
  user: SessionUser;
  mailboxId: string;
}

export async function account(pool: pg.Pool, role: "owner" | "friend"): Promise<Account> {
  const u = await createUser(pool, { role });
  const mailboxId = await createMailbox(pool, u.id);
  const user: SessionUser = {
    userId: u.id,
    email: u.email,
    name: u.name,
    image: null,
    sessionId: "s",
    sessionCreatedAt: new Date(),
    role,
  };
  return { user, mailboxId };
}

/** A designed email nobody has analysed yet (no analysis row: the panel's empty state). */
export function notAnalysed(): Partial<EmailRecord> {
  return { designStatus: "pending", designSource: "none", designAiState: "pending", analysis: null };
}

/** A realistic saved summary of a rendered analysis (the full measurements have been compacted). */
export function savedSummary(over: Partial<ScoreSummary> = {}): ScoreSummary {
  return {
    scoringVersion: SCORING_VERSION,
    coverage: "render",
    score: 78,
    raw: 78,
    band: "good",
    caps: [],
    confidence: 0.9,
    pillars: [
      { id: "accessibility", points: 20, max: 24 },
      { id: "mobile", points: 18, max: 22 },
    ],
    needsImprovement: [{ key: "check:B2", title: "Body text is 13px on mobile", points: 2, ai: false }],
    good: [{ key: "check:A1", title: "Text contrast passes everywhere", points: 6, ai: false }],
    fonts: null,
    ...over,
  };
}

export function withSummary(summary: ScoreSummary = savedSummary()): Partial<EmailRecord> {
  const base = emailRecord("", "");
  return {
    designStatus: "done",
    designSource: "render",
    designAiState: "done",
    designScore: summary.score,
    designBand: summary.band,
    designCapped: summary.caps.length > 0,
    designProvisional: false,
    designConfidence: "high",
    analysis: { ...base.analysis!, features: null, scoringVersion: summary.scoringVersion, scoreSummary: summary },
  };
}

export async function email(pool: pg.Pool, a: Account, over: Partial<EmailRecord> = {}): Promise<string> {
  return seedEmail(pool, a.user.userId, a.mailboxId, over);
}

export async function detail(a: Account, emailId: string): Promise<EmailDetail> {
  const { getEmailDetail } = await import("@/server/queries/email");
  const d = await getEmailDetail(a.user.userId, emailId, a.user.role);
  if (!d) throw new Error("email not found");
  return d;
}

export function governor(owner: pg.Pool) {
  let saved: unknown = null;
  return {
    async save(): Promise<void> {
      saved = (await owner.query("SELECT value FROM app_setting WHERE key = 'governor'")).rows[0]?.value ?? null;
    },
    async set(value: unknown): Promise<void> {
      await owner.query(
        `INSERT INTO app_setting (key, value) VALUES ('governor', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify(value)],
      );
    },
    async restore(): Promise<void> {
      await this.set(saved ?? { level: 0 });
    },
  };
}

export async function renderRequests(pool: pg.Pool, userId: string): Promise<number> {
  return withUser(pool, userId, async (_db, c) =>
    Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM render_request")).rows[0]!.n),
  );
}

/**
 * A rendered analysis whose full measurements are still kept (features at the current
 * SCORING_VERSION), so the page recomputes the full result: the design package's own synthetic
 * "well-designed promotional email", with or without its AI review.
 */
export async function withFullResult(opts: { ai: boolean }): Promise<Partial<EmailRecord>> {
  const { baseFeatures } = await import("../../../../packages/design/test/helpers/factory");
  const features = baseFeatures(opts.ai ? {} : { ai: null });
  const base = emailRecord("", "");
  return {
    designStatus: "done",
    designSource: "render",
    designAiState: opts.ai ? "done" : "pending",
    designScore: null,
    designBand: null,
    designProvisional: false,
    analysis: { ...base.analysis!, scoringVersion: SCORING_VERSION, features, scoreSummary: null },
  };
}
