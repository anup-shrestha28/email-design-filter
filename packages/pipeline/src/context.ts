/**
 * Per-message context looked up (inside the ingest transaction) before classification:
 * the sender prior and the template context (DESIGN.md §7.3 steps 15–16, FREE-TIER.md §5.4).
 */
import type { PoolClient } from "@edf/db";
import { EMAIL_TYPES, type EmailType, type SenderPrior } from "@edf/core/types";
import type { DesignFeatures } from "@edf/design";
import type { TemplateContext } from "./analyze";

const TYPE_SET = new Set<string>(EMAIL_TYPES);
const isEmailType = (x: unknown): x is EmailType => typeof x === "string" && TYPE_SET.has(x);

export interface SenderContext {
  prior: SenderPrior | null;
  blockedPersonal: boolean;
  senderId: string | null;
}

export async function lookupSender(c: PoolClient, userId: string, address: string | null): Promise<SenderContext> {
  if (!address) return { prior: null, blockedPersonal: false, senderId: null };
  const r = await c.query<{
    id: string;
    type_override: string | null;
    type_distribution: Record<string, number> | null;
    read_rate_60d: number | null;
    emails_per_week: number | null;
    user_importance_bias: number;
    muted: boolean;
  }>(
    `SELECT id, type_override, type_distribution, read_rate_60d, emails_per_week, user_importance_bias, muted
     FROM sender WHERE user_id = $1 AND address = $2`,
    [userId, address],
  );
  const s = r.rows[0];
  if (!s) return { prior: null, blockedPersonal: false, senderId: null };
  const dist = s.type_distribution ?? {};
  let total = 0;
  let majorityType: EmailType | null = null;
  let majority = 0;
  for (const [t, n] of Object.entries(dist)) {
    const count = Number(n) || 0;
    total += count;
    if (isEmailType(t) && count > majority) {
      majority = count;
      majorityType = t;
    }
  }
  return {
    senderId: s.id,
    blockedPersonal: s.type_override === "personal",
    prior: {
      typeOverride: isEmailType(s.type_override) ? s.type_override : null,
      majorityType,
      majorityShare: total > 0 ? majority / total : 0,
      emailCount: total,
      readRate60d: s.read_rate_60d,
      emailsPerWeek: s.emails_per_week,
      userImportanceBias: s.user_importance_bias,
      muted: s.muted,
    },
  };
}

export async function lookupTemplate(c: PoolClient, senderId: string | null, simhash: string | null): Promise<TemplateContext | null> {
  if (!senderId || !simhash) return null;
  const r = await c.query<{
    seen_count: number;
    classification: { primaryType?: unknown; subtype?: unknown } | null;
    exemplar_email_id: string | null;
    exemplar_rendered_at: Date | null;
    features: DesignFeatures | null;
  }>(
    `SELECT t.seen_count, t.classification, t.exemplar_email_id, t.exemplar_rendered_at, a.features
     FROM email_template t
     LEFT JOIN email_analysis a ON a.email_id = t.exemplar_email_id AND a.user_id = t.user_id
     WHERE t.sender_id = $1 AND bit_count((t.simhash # $2::bigint)::bit(64)) <= 3
     ORDER BY bit_count((t.simhash # $2::bigint)::bit(64)), t.last_seen_at DESC LIMIT 1`,
    [senderId, simhash],
  );
  const t = r.rows[0];
  if (!t) return null;
  const cls = t.classification;
  return {
    seenCount: t.seen_count,
    classification:
      cls && isEmailType(cls.primaryType)
        ? { primaryType: cls.primaryType, subtype: typeof cls.subtype === "string" ? cls.subtype : null }
        : null,
    exemplar:
      t.exemplar_email_id && t.exemplar_rendered_at && t.features && t.features.render
        ? { emailId: t.exemplar_email_id, renderedAt: t.exemplar_rendered_at, features: t.features }
        : null,
  };
}

export async function userAddresses(c: PoolClient, userId: string): Promise<string[]> {
  const r = await c.query<{ a: string }>("SELECT lower(email_address::text) AS a FROM mailbox WHERE user_id = $1", [userId]);
  return r.rows.map((x) => x.a);
}
