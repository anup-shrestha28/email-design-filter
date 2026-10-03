/**
 * DEVELOPMENT ONLY — seed a demo account with realistic, fictional data so the UI can be built
 * and reviewed before a real mailbox is connected.
 *
 *   pnpm --filter @edf/web seed-demo            # creates demo@edf.local / password "demo-password-123"
 *
 * Refuses to run against anything but localhost. All brands, people and domains are fictional.
 */
import { randomUUID } from "node:crypto";
import { pg } from "@edf/db";
import { hashPassword } from "better-auth/crypto";

const DB_URL = process.env.DATABASE_URL ?? "";
const OWNER_URL = process.env.DATABASE_URL_OWNER ?? "";
for (const u of [DB_URL, OWNER_URL]) {
  const host = (() => {
    try {
      return new URL(u).hostname;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1", "::1"].includes(host) || process.env.NODE_ENV === "production") {
    console.error("seed-demo only runs against a local database (DATABASE_URL and DATABASE_URL_OWNER).");
    process.exit(1);
  }
}

const EMAIL = process.env.DEMO_EMAIL ?? "demo@edf.local";
const PASSWORD = "demo-password-123";

// Deterministic PRNG so the demo looks the same every time.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const between = (a: number, b: number) => a + rnd() * (b - a);

type Band = "excellent" | "good" | "needs_work" | "poor";
interface SenderSpec {
  name: string;
  address: string;
  domain: string;
  type: string;
  subtypes: string[];
  esp: string | null;
  perWeek: number;
  design: [number, number]; // score range
  fonts: string[];
  webFonts: boolean;
  readRate: number;
  subjects: string[];
  subscription: boolean;
  deal?: boolean;
  issues?: string[];
}

const SENDERS: SenderSpec[] = [
  { name: "Northwind Outfitters", address: "hello@northwind-outfitters.com", domain: "northwind-outfitters.com", type: "promotional", subtypes: ["sale", "product_launch"], esp: "Klaviyo", perWeek: 3, design: [78, 92], fonts: ["Montserrat", "Inter"], webFonts: true, readRate: 0.42, subscription: true, deal: true, subjects: ["30% off everything ends tonight", "New: the Alder rain shell", "Your weekend trail kit", "Last call: free shipping over $75", "Fall boots are here"] },
  { name: "Field Notes Weekly", address: "weekly@fieldnotes.example", domain: "fieldnotes.example", type: "newsletter", subtypes: ["editorial"], esp: "Mailgun", perWeek: 1, design: [86, 95], fonts: ["Georgia"], webFonts: false, readRate: 0.88, subscription: true, subjects: ["Issue #112: Why small teams ship faster", "Issue #111: The cost of meetings", "Issue #110: Writing decisions down", "Issue #109: Narrow ownership"] },
  { name: "Lumen Bank", address: "alerts@lumenbank.example", domain: "lumenbank.example", type: "account_security", subtypes: ["login_alert", "verification_code"], esp: null, perWeek: 0.6, design: [0, 0], fonts: [], webFonts: false, readRate: 0.95, subscription: false, subjects: ["New sign-in to your account", "Your verification code", "Security alert: password changed"] },
  { name: "Parcelly", address: "track@parcelly.example", domain: "parcelly.example", type: "transactional", subtypes: ["shipping"], esp: "SendGrid", perWeek: 1.2, design: [66, 80], fonts: ["Roboto"], webFonts: true, readRate: 0.9, subscription: false, subjects: ["Your package is out for delivery", "Shipped: order #48213", "Delivered: your package"] },
  { name: "Brightside Airlines", address: "trips@brightside-air.example", domain: "brightside-air.example", type: "transactional", subtypes: ["travel"], esp: "Salesforce Marketing Cloud", perWeek: 0.3, design: [72, 84], fonts: ["Source Sans 3"], webFonts: true, readRate: 1, subscription: false, subjects: ["Your trip to Lisbon is confirmed", "Check in now for flight BS 214"] },
  { name: "Kettle & Crumb", address: "news@kettleandcrumb.example", domain: "kettleandcrumb.example", type: "promotional", subtypes: ["sale", "coupon"], esp: "Mailchimp", perWeek: 2, design: [28, 46], fonts: ["Arial"], webFonts: false, readRate: 0.05, subscription: true, deal: true, issues: ["image_only"], subjects: ["🍞 BAKE SALE!!! 40% OFF", "Weekend treats inside", "YOUR COUPON EXPIRES SOON", "Fresh loaves, fresh deals"] },
  { name: "Orbit Cloud", address: "product@orbitcloud.example", domain: "orbitcloud.example", type: "product_update", subtypes: ["release_notes", "feature"], esp: "Customer.io", perWeek: 0.7, design: [80, 90], fonts: ["Inter"], webFonts: true, readRate: 0.61, subscription: true, subjects: ["What's new in Orbit: faster deploys", "Introducing preview environments", "September release notes"] },
  { name: "Pixelforge", address: "team@pixelforge.example", domain: "pixelforge.example", type: "lifecycle", subtypes: ["welcome", "trial_ending"], esp: "Intercom", perWeek: 0.5, design: [70, 82], fonts: ["Poppins", "Helvetica"], webFonts: true, readRate: 0.5, subscription: true, subjects: ["Welcome to Pixelforge 👋", "Your trial ends in 3 days", "3 tips to get started"] },
  { name: "Commons Forum", address: "digest@commons-forum.example", domain: "commons-forum.example", type: "community", subtypes: ["forum"], esp: null, perWeek: 2, design: [55, 68], fonts: ["Helvetica"], webFonts: false, readRate: 0.3, subscription: true, subjects: ["[Commons] Weekly digest", "[Commons] New reply in 'Self-hosting tips'", "[Commons] Popular this week"] },
  { name: "Civic Events", address: "events@civic-events.example", domain: "civic-events.example", type: "event", subtypes: ["invitation", "webinar"], esp: "HubSpot", perWeek: 0.5, design: [68, 83], fonts: ["Lato"], webFonts: true, readRate: 0.4, subscription: true, subjects: ["You're invited: Design Systems Night", "Starting in 1 hour: Accessible email webinar"] },
  { name: "Streamline HR", address: "surveys@streamline-hr.example", domain: "streamline-hr.example", type: "survey", subtypes: [], esp: "Qualtrics", perWeek: 0.2, design: [60, 72], fonts: ["Arial"], webFonts: false, readRate: 0.2, subscription: true, subjects: ["How are we doing? 2-minute survey"] },
  { name: "Harbor Health", address: "notices@harborhealth.example", domain: "harborhealth.example", type: "account_notice", subtypes: ["terms"], esp: null, perWeek: 0.2, design: [62, 74], fonts: ["Verdana"], webFonts: false, readRate: 0.7, subscription: false, subjects: ["Updates to our Privacy Policy"] },
  { name: "Nova Market", address: "deals@novamarket.example", domain: "novamarket.example", type: "promotional", subtypes: ["sale", "recommendation"], esp: "Braze", perWeek: 4, design: [58, 76], fonts: ["Montserrat", "Arial"], webFonts: true, readRate: 0.12, subscription: true, deal: true, subjects: ["Flash sale: 24 hours only", "Picked for you", "Up to 60% off electronics", "BOGO on home essentials"] },
  { name: "The Daily Brief", address: "brief@dailybrief.example", domain: "dailybrief.example", type: "newsletter", subtypes: ["digest"], esp: "beehiiv", perWeek: 6, design: [74, 86], fonts: ["Merriweather", "Arial"], webFonts: true, readRate: 0.66, subscription: true, subjects: ["Morning brief: markets, climate, and a comet", "Morning brief: the week ahead", "Morning brief: five things to know"] },
  { name: "Loopbook", address: "notify@loopbook.example", domain: "loopbook.example", type: "social", subtypes: ["mention"], esp: null, perWeek: 3, design: [64, 78], fonts: ["Roboto"], webFonts: false, readRate: 0.25, subscription: true, subjects: ["Maya mentioned you in a comment", "You have 3 new followers", "Your post is getting attention"] },
  { name: "Acme Payments", address: "billing@acmepay.example", domain: "acmepay.example", type: "transactional", subtypes: ["payment_failed", "receipt"], esp: "Postmark", perWeek: 0.3, design: [70, 80], fonts: ["Helvetica"], webFonts: false, readRate: 1, subscription: false, subjects: ["Action needed: your payment failed", "Receipt for your September invoice"] },
  { name: "Glide Rides", address: "receipts@gliderides.example", domain: "gliderides.example", type: "transactional", subtypes: ["receipt"], esp: "Amazon SES", perWeek: 1, design: [82, 91], fonts: ["Inter"], webFonts: true, readRate: 0.8, subscription: false, subjects: ["Your Tuesday evening ride", "Your Friday morning ride"] },
  { name: "Sprout Kitchen", address: "hello@sproutkitchen.example", domain: "sproutkitchen.example", type: "promotional", subtypes: ["product_launch"], esp: "Klaviyo", perWeek: 1.5, design: [50, 66], fonts: ["Playfair Display", "Lato"], webFonts: true, readRate: 0.2, subscription: true, deal: true, issues: ["mobile"], subjects: ["New autumn menu drops Thursday", "Soup season is here", "Free delivery this weekend"] },
  { name: "Atlas Weather", address: "alerts@atlasweather.example", domain: "atlasweather.example", type: "notification", subtypes: ["reminder"], esp: null, perWeek: 2, design: [0, 0], fonts: [], webFonts: false, readRate: 0.5, subscription: true, subjects: ["Rain expected tomorrow morning", "Frost advisory tonight"] },
  { name: "Quill Journal", address: "letters@quilljournal.example", domain: "quilljournal.example", type: "newsletter", subtypes: ["editorial"], esp: "Substack", perWeek: 1, design: [80, 90], fonts: ["Lora", "Georgia"], webFonts: true, readRate: 0.72, subscription: true, subjects: ["On slowness", "The garden in October", "Letters from the coast"] },
  { name: "Tern Travel", address: "offers@terntravel.example", domain: "terntravel.example", type: "promotional", subtypes: ["sale"], esp: "Iterable", perWeek: 1, design: [72, 86], fonts: ["Nunito Sans"], webFonts: true, readRate: 0.18, subscription: true, deal: true, subjects: ["Fares from $89 to the coast", "Weekend getaways under $300"] },
  { name: "Mosaic Design Weekly", address: "hi@mosaicweekly.example", domain: "mosaicweekly.example", type: "newsletter", subtypes: ["digest"], esp: "ConvertKit", perWeek: 1, design: [90, 98], fonts: ["DM Sans", "DM Serif Display"], webFonts: true, readRate: 0.93, subscription: true, subjects: ["Mosaic #204: Type pairing that works", "Mosaic #203: Color systems", "Mosaic #202: Grids for email"] },
  { name: "ByteBurst", address: "promo@byteburst.example", domain: "byteburst.example", type: "promotional", subtypes: ["sale"], esp: "Sailthru", perWeek: 2, design: [40, 58], fonts: ["Open Sans"], webFonts: true, readRate: 0.03, subscription: true, deal: true, issues: ["contrast"], subjects: ["Mega gadget deals", "Price drop alert", "Last chance: mega deals"] },
  { name: "Evergreen Utilities", address: "billing@evergreen-util.example", domain: "evergreen-util.example", type: "transactional", subtypes: ["invoice"], esp: null, perWeek: 0.25, design: [0, 0], fonts: [], webFonts: false, readRate: 1, subscription: false, subjects: ["Your October statement is ready"] },
];

const PILLARS = [
  ["accessibility", "Accessibility", 20],
  ["mobile", "Mobile & Responsiveness", 15],
  ["typography", "Readability & Typography", 15],
  ["hierarchy", "Visual Hierarchy & CTA", 15],
  ["images", "Images & Media", 10],
  ["layout", "Layout, Color & Consistency", 10],
  ["content", "Content & Structure", 5],
  ["technical", "Technical Health", 5],
  ["footer", "Footer & Unsubscribe UX", 5],
] as const;

function bandOf(score: number): Band {
  return score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "needs_work" : "poor";
}

function summary(score: number, coverage: "render" | "template" | "static", issues: string[], fonts: string[], webFonts: boolean) {
  const ratio = score / 100;
  const pillars = PILLARS.map(([id, , max]) => {
    const jitter = Math.min(1, Math.max(0.1, ratio + between(-0.12, 0.12)));
    return { id, points: Math.round(max * jitter * 10) / 10, max };
  });
  const needs = [
    issues.includes("contrast") && { key: "cap:CAP_CONTRAST", title: "46% of body text fails WCAG AA contrast (grey #A0A0A0 on white = 2.6:1)", points: 7.4, ai: false },
    issues.includes("image_only") && { key: "cap:CAP_IMAGE_ONLY", title: "The message is one large image: blank with images off and nothing for screen readers", points: 12.1, ai: false },
    issues.includes("mobile") && { key: "group:fixed-width", title: "The layout is a fixed 640px, so on phones it shrinks to 59%: body text becomes ~8.8px", points: 9.2, ai: false },
    score < 85 && { key: "check:A2", title: "3 of 11 images have no alt text (incl. the hero banner)", points: 1.8, ai: false },
    score < 80 && { key: "check:U2", title: "Unsubscribe link is 10px light-grey text (contrast 2.1:1) — aim for ≥ 12px and ≥ 4.5:1", points: 1.2, ai: false },
    score < 90 && { key: "check:X1", title: "HTML is 94 KB — close to Gmail's ~102 KB clipping limit", points: 0.6, ai: false },
  ].filter(Boolean) as Array<{ key: string; title: string; points: number; ai: boolean }>;
  const good = [
    score >= 70 && { key: "check:H2", title: "Primary button is in the first screen on mobile and 48px tall", points: 2, ai: false },
    score >= 75 && { key: "check:T1", title: "Body text is 16px on mobile with a measured line height of 1.5", points: 4, ai: false },
    score >= 70 && { key: "check:M1", title: "Fits a 375px phone without shrinking; single-column layout", points: 2.5, ai: false },
    score >= 80 && { key: "check:I2", title: "Headline and offer are live text — readable with images off", points: 2, ai: false },
    score >= 85 && coverage === "render" && { key: "ai:H7", title: "One clear focal point; secondary products visually subordinate", points: 5.2, ai: true },
  ].filter(Boolean) as Array<{ key: string; title: string; points: number; ai: boolean }>;
  return {
    scoringVersion: "2026.1+demo",
    coverage,
    score: coverage === "static" ? null : score,
    raw: coverage === "static" ? null : score,
    band: coverage === "static" ? null : bandOf(score),
    caps: issues.map((i) => ({ image_only: "CAP_IMAGE_ONLY", contrast: "CAP_CONTRAST", mobile: "CAP_MOBILE_BROKEN", clipped: "CAP_CLIPPED", broken_images: "CAP_BROKEN_IMAGES" })[i]),
    confidence: coverage === "render" ? 0.915 : coverage === "template" ? 0.71 : 0.225,
    pillars,
    needsImprovement: needs.slice(0, 5),
    good: good.slice(0, 5),
    fonts: fonts.length
      ? {
          families: fonts.slice(0, 3).map((f, i) => ({ name: f, share: i === 0 ? 0.62 : 0.3, role: i === 0 ? "body" : "heading", class: webFonts ? "web" : "system" })),
          gmailWeb: webFonts ? "Arial" : fonts[0],
          outlookClassic: webFonts ? "Times New Roman" : fonts[0],
          outlookClassicWarning: webFonts,
        }
      : null,
  };
}

async function main() {
  const owner = new pg.Client({ connectionString: OWNER_URL });
  await owner.connect();
  await owner.query(
    `INSERT INTO beta_allowlist (email, role, invited_by) VALUES ($1, 'owner', 'seed') ON CONFLICT (email) DO UPDATE SET role = 'owner'`,
    [EMAIL],
  );
  await owner.end();

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  const existing = await client.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [EMAIL]);
  let userId = existing.rows[0]?.id;
  if (userId) {
    await client.query(`DELETE FROM "user" WHERE id = $1`, [userId]); // cascade: start fresh
  }
  userId = `demo_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await client.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, 'Alex Rivera', $2, true)`, [userId, EMAIL]);
  await client.query(
    `INSERT INTO account (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), userId, await hashPassword(PASSWORD)],
  );

  await client.query("BEGIN");
  await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
  await client.query(
    `INSERT INTO user_settings (user_id, role, backfill_window_days, ai_processing_consent_at, last_active_at)
     VALUES ($1, 'owner', 90, now() - interval '20 days', now() - interval '6 hours')`,
    [userId],
  );
  const mb = await client.query<{ id: string }>(
    `INSERT INTO mailbox (user_id, provider, provider_account_id, email_address, status, kek_version, history_id,
       last_synced_at, next_poll_at, backfill_state, backfill_progress, granted_scopes)
     VALUES ($1, 'gmail', $2, 'alex.rivera@example.com', 'active', 'local:v1', 184467, now() - interval '12 minutes',
       now() + interval '18 minutes', 'done', '{"listed": 812, "windowDays": 90}', '{openid,email,https://www.googleapis.com/auth/gmail.readonly}')
     RETURNING id`,
    [userId, `demo-sub-${userId}`],
  );
  const mailboxId = mb.rows[0]!.id;

  const now = Date.now();
  let emails = 0;
  for (const s of SENDERS) {
    const count = Math.max(1, Math.round(s.perWeek * 8.5 * between(0.8, 1.2)));
    const firstSeen = new Date(now - between(45, 60) * 86_400_000);
    const isNew = s.name === "Pixelforge" || s.name === "Tern Travel";
    const sender = await client.query<{ id: string }>(
      `INSERT INTO sender (user_id, address, display_name, domain, esp_platform, first_seen_at, last_seen_at, seen_before_window,
         email_count, emails_per_week, frequency_band, read_rate_60d, primary_type, one_click_unsubscribe, list_unsubscribe,
         auth_summary, avg_design_score, unsubscribed_at, muted)
       VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, false) RETURNING id`,
      [
        userId, s.address, s.name, s.domain, s.esp,
        isNew ? new Date(now - 6 * 86_400_000) : firstSeen, !isNew, count, s.perWeek,
        s.perWeek >= 5 ? "daily" : s.perWeek >= 2 ? "several_weekly" : s.perWeek >= 0.8 ? "weekly" : s.perWeek >= 0.2 ? "monthly" : "rare",
        s.readRate, s.type, s.subscription,
        s.subscription ? JSON.stringify({ https: [`https://${s.domain}/unsubscribe?u=demo`], mailto: [`mailto:unsubscribe@${s.domain}`] }) : null,
        JSON.stringify({ trust: s.name === "ByteBurst" ? "partial" : "trusted", dmarc: "pass" }),
        s.design[1] > 0 ? (s.design[0] + s.design[1]) / 2 : null,
        s.name === "Kettle & Crumb" ? new Date(now - 20 * 86_400_000) : null,
      ],
    );
    const senderId = sender.rows[0]!.id;
    const tpl = await client.query<{ id: string }>(
      `INSERT INTO email_template (user_id, sender_id, simhash, first_seen_at, last_seen_at, email_count, seen_count)
       VALUES ($1, $2, $3, $4, now(), $5, $5) RETURNING id`,
      [userId, senderId, BigInt(Math.floor(rnd() * 2 ** 52)).toString(), firstSeen, count],
    );
    const templateId = tpl.rows[0]!.id;

    for (let i = 0; i < count; i++) {
      const ageDays = isNew ? between(0, 6) : i === 0 ? between(0, 1.5) : between(0, 58);
      const received = new Date(now - ageDays * 86_400_000);
      const subject = pick(s.subjects);
      const security = s.type === "account_security";
      const plain = s.name === "Atlas Weather" || s.name === "Evergreen Utilities";
      const designable = !security && !plain;
      const coverage: "render" | "template" | "static" = !designable ? "static" : rnd() < 0.5 ? "render" : rnd() < 0.6 ? "template" : "static";
      const score = designable ? Math.round(between(s.design[0], s.design[1])) : 0;
      const issues = designable && coverage !== "static" ? (s.issues ?? []) : [];
      const capped = issues.length > 0;
      const band = designable && coverage !== "static" ? bandOf(score) : null;
      const provisional = coverage === "template" && rnd() < 0.3;
      const isHigh =
        (security && ageDays < 2) || subject.startsWith("Action needed") || subject.includes("out for delivery") || subject.includes("Check in");
      const importance = isHigh ? "high" : s.readRate > 0.6 ? "normal" : s.readRate < 0.1 ? "low" : "normal";
      const reasons = isHigh
        ? [security ? "type:security_alert" : subject.startsWith("Action") ? "type:payment_failed" : "type:shipping"]
        : s.readRate > 0.6 ? ["engaged_sender"] : s.readRate < 0.1 ? ["never_opened_sender"] : [];
      const hasDeal = Boolean(s.deal) && rnd() < 0.7;
      const dealEnds = hasDeal ? new Date(received.getTime() + between(0.5, 6) * 86_400_000) : null;
      const unread = rnd() > s.readRate;
      const e = await client.query<{ id: string }>(
        `INSERT INTO email (user_id, mailbox_id, sender_id, template_id, provider_message_id, provider_thread_id, gmail_history_id,
           received_at, subject, from_address, from_name, snippet, label_ids, is_unread, opened_in_app_at, gmail_category,
           size_bytes, html_bytes, language, security_sensitive, is_subscription, subscription_score, primary_type, subtype,
           type_confidence, type_source, importance, importance_score, importance_reasons, list_id, one_click_unsubscribe,
           auth_result, suspicious, esp_platform, tracker_count, utm_campaign, design_status, design_source, design_ai_state,
           design_score, design_band, design_capped, design_provisional, design_issues, design_confidence, font_source,
           font_families, uses_web_fonts, has_deal, deal_has_code, deal_ends_at, search_tsv, created_at)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'en',$18,$19,$20,$21,$22,$23,'rule',$24,$25,$26,$27,
           $28,'pass',false,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,
           to_tsvector('simple', $47), $7)
         RETURNING id`,
        [
          userId, mailboxId, senderId, designable ? templateId : null, randomUUID().replaceAll("-", "").slice(0, 16), String(184000 + emails), received,
          subject, s.address, s.name,
          security ? null : `${subject}. ${pick(["Take a look at what's new this week.", "Here's a quick summary of your update.", "Open for details and next steps.", "We thought you'd like to know."])}`,
          unread ? ["INBOX", "UNREAD", `CATEGORY_${s.subscription ? "PROMOTIONS" : "UPDATES"}`] : ["INBOX", `CATEGORY_${s.subscription ? "PROMOTIONS" : "UPDATES"}`],
          unread, unread ? null : received, s.type === "promotional" ? "promotions" : "updates",
          Math.round(between(20_000, 120_000)), plain ? 0 : Math.round(between(18_000, 98_000)),
          security, s.subscription, s.subscription ? Math.round(between(60, 95)) : Math.round(between(20, 50)),
          s.type, s.subtypes.length ? pick(s.subtypes) : null, between(0.75, 0.99),
          importance, isHigh ? 72 : s.readRate > 0.6 ? 45 : s.readRate < 0.1 ? 12 : 30, reasons,
          s.type === "community" ? "digest.commons-forum.example" : null, s.subscription,
          s.esp, security ? 0 : Math.floor(between(0, 4)), s.type === "promotional" ? "autumn-2026" : null,
          plain ? "plain_text" : security ? "skipped" : "done",
          designable ? coverage : "none",
          !designable ? "not_applicable" : coverage === "render" ? pick(["done", "done", "pending"]) : coverage === "template" ? "from_template" : "pending",
          designable && coverage !== "static" ? (capped ? Math.min(score, 59) : score) : null,
          band && capped ? (Math.min(score, 59) >= 50 ? "needs_work" : "poor") : band,
          designable && coverage !== "static" ? capped : null,
          designable && coverage !== "static" ? provisional : null,
          issues,
          designable && coverage !== "static" ? (coverage === "render" ? "high" : "medium") : null,
          designable ? coverage : "none",
          designable ? s.fonts : [],
          designable && s.webFonts,
          hasDeal, hasDeal && rnd() < 0.6, dealEnds,
          `${subject} ${s.name} ${s.address}`,
        ],
      );
      const emailId = e.rows[0]!.id;
      if (designable) {
        const sm = summary(capped ? Math.min(score, 59) : score, coverage, issues, s.fonts, s.webFonts);
        await client.query(
          `INSERT INTO email_analysis (email_id, user_id, scoring_version, features, checks, pillar_scores, raw_score, caps, confidence,
             trust, score_summary, renderer_host, analyzed_at)
           VALUES ($1, $2, $3, NULL, '[]', $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            emailId, userId, sm.scoringVersion, JSON.stringify(sm.pillars), sm.raw, sm.caps.filter(Boolean), sm.confidence,
            JSON.stringify({ state: s.name === "ByteBurst" ? "partial" : "trusted", spf: "pass", dkim: "pass", dmarc: "pass", oneClick: s.subscription, visibleUnsubscribe: s.subscription, postalAddress: s.subscription ? rnd() > 0.2 : null, missing: s.name === "ByteBurst" ? ["postal_address"] : [], tracking: { pixels: 1, clickTrackerHosts: s.esp ? [`click.${s.domain}`] : [], utmCampaign: null } }),
            JSON.stringify(sm), coverage === "render" ? "local" : null, received,
          ],
        );
      }
      if (hasDeal) {
        await client.query(
          `INSERT INTO deal (email_id, user_id, sender_id, kind, value, currency, is_up_to, code, ends_at, ends_at_confidence, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0.8, 'regex') ON CONFLICT DO NOTHING`,
          [emailId, userId, senderId, pick(["percent_off", "percent_off", "amount_off", "free_shipping", "bogo"]), Math.round(between(10, 60)), "USD", rnd() < 0.3, rnd() < 0.6 ? pick(["AUTUMN30", "FRESH20", "WEEKEND", "SAVE15"]) : null, dealEnds],
        );
      }
      await client.query(
        `INSERT INTO message_ledger (mailbox_id, user_id, provider_message_id, state, source)
         SELECT mailbox_id, user_id, provider_message_id, 'stored', 'backfill' FROM email WHERE id = $1`,
        [emailId],
      );
      emails++;
    }
  }
  // A suspicious one (DMARC fail, unaligned) and one still-pending AI classification.
  await client.query(
    `UPDATE email SET suspicious = true, auth_result = 'fail' WHERE id = (
       SELECT id FROM email WHERE user_id = $1 AND primary_type = 'account_security' ORDER BY received_at DESC LIMIT 1)`,
    [userId],
  );
  await client.query(
    `UPDATE email SET type_source = 'pending' WHERE id = (SELECT id FROM email WHERE user_id = $1 AND primary_type = 'other' LIMIT 1)`,
    [userId],
  );
  await client.query("COMMIT");
  await client.end();
  console.log(`Seeded ${emails} emails from ${SENDERS.length} senders for ${EMAIL} (password: ${PASSWORD}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
