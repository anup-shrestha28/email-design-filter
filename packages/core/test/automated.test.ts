import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyAutomated, decideSubscription, parseListUnsubscribe } from "../src/index";
import type { ClassifyAutomatedInput } from "../src/index";
import {
  analyze,
  FIXTURE_DIR,
  fakeContent,
  fakeHeaders,
  fakeParsed,
  runPipeline,
  typeOf,
} from "./helpers";

function run(overrides: Partial<ClassifyAutomatedInput> = {}) {
  return classifyAutomated({
    parsed: fakeParsed(),
    headers: fakeHeaders(),
    content: fakeContent(),
    labelIds: ["INBOX"],
    priorContact: null,
    senderTemplateRepeats: false,
    security: { securitySensitive: false, reason: null },
    ...overrides,
  });
}

const LU = parseListUnsubscribe("<https://acme.example/u?t=1>");
const none = {
  hardSignal: false,
  hardPositive: false,
  hasUnsubscribeMechanism: true,
  provisional: true,
};

describe("subscription thresholds (DESIGN.md §7.2 step 4)", () => {
  it("24 → not automated, 25 → automated and ambiguous", () => {
    expect(decideSubscription(24, none)).toEqual({
      automated: false,
      isSubscription: false,
      ambiguous: false,
    });
    expect(decideSubscription(25, none)).toEqual({
      automated: true,
      isSubscription: true,
      ambiguous: true,
    });
    expect(decideSubscription(25, { ...none, provisional: false })).toMatchObject({
      isSubscription: false,
      ambiguous: true,
    });
  });

  it("44 → ambiguous, 45 → subscription", () => {
    expect(decideSubscription(44, { ...none, provisional: false })).toEqual({
      automated: true,
      isSubscription: false,
      ambiguous: true,
    });
    expect(decideSubscription(45, { ...none, provisional: false })).toEqual({
      automated: true,
      isSubscription: true,
      ambiguous: false,
    });
  });

  it("a hard signal makes low scores automated; the hard positive makes them subscriptions", () => {
    expect(decideSubscription(0, { ...none, hardSignal: true, provisional: false })).toEqual({
      automated: true,
      isSubscription: false,
      ambiguous: false,
    });
    expect(
      decideSubscription(30, { ...none, hardPositive: true, provisional: false }),
    ).toMatchObject({ isSubscription: true, ambiguous: false });
  });

  it("no unsubscribe mechanism → never a subscription (§7.1)", () => {
    expect(decideSubscription(90, { ...none, hasUnsubscribeMechanism: false })).toMatchObject({
      automated: true,
      isSubscription: false,
    });
  });
});

describe("classifyAutomated with real signal combinations", () => {
  it("20 (Feedback-ID + BCC) is personal", () => {
    const v = run({ headers: fakeHeaders({ feedbackId: "1:2:x", deliveredByBcc: true }) });
    expect(v.subscriptionScore).toBe(20);
    expect(v).toMatchObject({ automated: false, skipReason: "personal" });
  });

  it("25 (ESP + Updates category) is automated, ambiguous, and worth a prior-contact check", () => {
    const v = run({
      headers: fakeHeaders({ espPlatform: "Braze" }),
      labelIds: ["INBOX", "CATEGORY_UPDATES"],
    });
    expect(v).toMatchObject({
      automated: true,
      subscriptionScore: 25,
      ambiguous: true,
      isSubscription: false,
      needsPriorContactCheck: true,
    });
  });

  it("40 (List-Unsubscribe + BCC) is ambiguous with a provisional 'subscription'", () => {
    const v = run({ headers: fakeHeaders({ listUnsubscribe: LU, deliveredByBcc: true }) });
    expect(v).toMatchObject({
      automated: true,
      subscriptionScore: 40,
      ambiguous: true,
      isSubscription: true,
      needsPriorContactCheck: false,
    });
  });

  it("45 (List-Unsubscribe + Updates category) is a subscription", () => {
    const v = run({
      headers: fakeHeaders({ listUnsubscribe: LU }),
      labelIds: ["CATEGORY_UPDATES"],
    });
    expect(v).toMatchObject({ subscriptionScore: 45, ambiguous: false, isSubscription: true });
  });

  it("uses every §7.2 weight exactly", () => {
    const v = run({
      headers: fakeHeaders({
        listUnsubscribe: LU,
        oneClick: true,
        listId: "l.acme.example",
        feedbackId: "1:2:3:x",
        espPlatform: "Klaviyo",
        precedence: "bulk",
        autoSubmitted: "auto-generated",
        isNoReply: true,
        deliveredByBcc: true,
      }),
      content: fakeContent({
        hasUnsubscribeLink: true,
        tracking: {
          pixelCount: 1,
          pixelHosts: [],
          clickTrackerHosts: [],
          utmCampaign: null,
          utmMediumEmail: false,
        },
      }),
      labelIds: ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"],
      senderTemplateRepeats: true,
    });
    const total = v.signals.reduce((s, x) => s + x.weight, 0);
    expect(total).toBe(35 + 15 + 20 + 15 + 15 + 20 + 10 + 10 + 10 + 10 + 10 + 10 + 5 + 5);
    expect(v.subscriptionScore).toBe(100); // clamped for storage
    const neg = run({
      headers: fakeHeaders({ isFreemailSender: true }),
      labelIds: ["CATEGORY_PERSONAL"],
      priorContact: true,
    });
    expect(neg.signals.map((s) => s.weight).sort()).toEqual([-15, -15, -30].sort());
    expect(neg.subscriptionScore).toBe(0);
  });

  it("excludes SENT / DRAFT / CHAT / SPAM, the user's own mail and auto-replies with ledger reasons", () => {
    expect(run({ labelIds: ["SENT"] }).skipReason).toBe("sent");
    expect(run({ labelIds: ["DRAFT"] }).skipReason).toBe("draft");
    expect(run({ labelIds: ["CHAT"] }).skipReason).toBe("chat");
    expect(run({ labelIds: ["INBOX", "SPAM"] }).skipReason).toBe("spam");
    expect(run({ headers: fakeHeaders({ fromSelf: true }) }).skipReason).toBe("sent");
    expect(run({ headers: fakeHeaders({ autoSubmitted: "auto-replied" }) }).skipReason).toBe(
      "auto_reply",
    );
    expect(run({ parsed: fakeParsed({ subject: "Out of Office: back Monday" }) }).skipReason).toBe(
      "auto_reply",
    );
    expect(
      run({ parsed: fakeParsed({ subject: "Automatische Antwort: Rechnung" }) }).skipReason,
    ).toBe("auto_reply");
  });

  it("personal override: prior contact and no list headers → personal", () => {
    const v = run({
      headers: fakeHeaders({ espPlatform: "Braze" }),
      labelIds: ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES"],
      priorContact: true,
    });
    expect(v).toMatchObject({ automated: false, skipReason: "personal" });
  });

  it("the override never drops mail with a hard signal (schema.org Order) or list headers", () => {
    const order = run({
      priorContact: true,
      content: fakeContent({ schemaOrg: [{ type: "Order", fields: {} }] }),
    });
    expect(order).toMatchObject({ automated: true, hardSignals: ["schema_transactional"] });
    const listed = run({
      priorContact: true,
      headers: fakeHeaders({ listUnsubscribe: LU, listId: "x" }),
      labelIds: ["CATEGORY_UPDATES"],
    });
    expect(listed.automated).toBe(true); // 35 + 20 + 10 − 30 = 35
    expect(listed.subscriptionScore).toBe(35);
  });

  it("security-pattern and no-reply senders are automated even with a low score, unless free-mail", () => {
    const otp = run({ security: { securitySensitive: true, reason: "otp" } });
    expect(otp).toMatchObject({ automated: true, hardSignals: ["security_pattern"] });
    const friendQuotingCode = run({
      security: { securitySensitive: true, reason: "otp" },
      headers: fakeHeaders({ isFreemailSender: true }),
    });
    expect(friendQuotingCode.automated).toBe(false);
    expect(run({ headers: fakeHeaders({ isNoReply: true }) }).hardSignals).toContain("no_reply");
  });

  it("transactional ESPs and Auto-Submitted are hard signals", () => {
    expect(
      run({ headers: fakeHeaders({ espPlatform: "Postmark", espTransactional: true }) }).automated,
    ).toBe(true);
    expect(run({ headers: fakeHeaders({ autoSubmitted: "auto-notified" }) }).automated).toBe(true);
  });

  it("headers-only (metadata) evaluation flags transactional/security subjects for a full fetch", () => {
    const v = run({ content: null, parsed: fakeParsed({ subject: "Your verification code" }) });
    expect(v).toMatchObject({ automated: true, hardSignals: ["subject_hint"] });
    const plain = run({ content: null, parsed: fakeParsed({ subject: "Lunch tomorrow?" }) });
    expect(plain.automated).toBe(false);
  });
});

describe("self-hosted transactional mail (no ESP / list headers)", () => {
  const receipt = {
    from: "Tidewell Orders <orders@tidewell-outdoor.example>",
    subject: "Your order TW-20931 has shipped",
    html: "<h1>Your order has shipped</h1><p>Your rain shell is on its way. Coastal rain shell, size M — $129.00</p><p>Track your package at tidewell-outdoor.example/orders/TW-20931</p>",
  };

  async function both(spec: Parameters<typeof analyze>[0], priorContact: boolean | null = false) {
    const a = await analyze(spec);
    const base = {
      parsed: a.parsed,
      headers: a.headers,
      labelIds: ["INBOX"],
      priorContact,
      senderTemplateRepeats: false,
    };
    return {
      full: classifyAutomated({ ...base, content: a.content, security: a.security }),
      headersOnly: classifyAutomated({ ...base, content: null }),
    };
  }

  it("a transactional subject + body evidence from the shop's own domain is automated in both stages", async () => {
    const { full, headersOnly } = await both(receipt);
    expect(full).toMatchObject({
      automated: true,
      hardSignals: ["transactional_pattern"],
      isSubscription: false,
    });
    expect(headersOnly).toMatchObject({ automated: true, hardSignals: ["subject_hint"] });
  });

  it("the design fixture repro is kept (automated, transactional/shipping)", async () => {
    const path = join(FIXTURE_DIR, "design/16-transactional-receipt.eml");
    if (!existsSync(path)) return; // owned by the design fixtures; skip if moved
    const r = await runPipeline(readFileSync(path), {
      labelIds: ["INBOX"],
      receivedAt: "2026-09-25T14:02:15Z",
      userAddresses: ["reader@inbox-owner.net"],
      priorContact: false,
      senderTemplateRepeats: false,
    });
    expect(r.automated).toMatchObject({ automated: true, skipReason: null });
    expect(r.type).toMatchObject({ primaryType: "transactional", subtype: "shipping" });
  });

  it("guardrail: a person on gmail.com writing about an order stays personal", async () => {
    const { full, headersOnly } = await both({ ...receipt, from: "Sam <sam.rivera@gmail.com>" });
    expect(full).toMatchObject({ automated: false, skipReason: "personal" });
    expect(headersOnly).toMatchObject({ automated: false, skipReason: "personal" });
  });

  it("guardrail: human reply threads (Re:/Fwd:, In-Reply-To) are not transactional patterns", async () => {
    expect(
      (await both({ ...receipt, subject: "Re: Your order TW-20931 has shipped" })).full.automated,
    ).toBe(false);
    expect(
      (await both({ ...receipt, headers: ["In-Reply-To: <abc@tidewell-outdoor.example>"] })).full
        .automated,
    ).toBe(false);
  });

  it("guardrail: a transactional subject without transactional evidence in the body is not enough", async () => {
    const { full } = await both({
      ...receipt,
      html: "<p>Hi Nova, can we move lunch to Thursday?</p>",
    });
    expect(full).toMatchObject({ automated: false, skipReason: "personal" });
  });

  it("the personal override still applies without a hard signal", async () => {
    const { full } = await both(
      {
        from: "Kim <kim@acme.example>",
        subject: "Lunch on Thursday?",
        text: "Want to try the new place?",
      },
      true,
    );
    expect(full).toMatchObject({ automated: false, skipReason: "personal" });
  });

  it("recognises WooCommerce-style subjects without misreading promos as orders", async () => {
    const woo = await both({
      from: "Shop <orders@hollowpine.example>",
      subject: "Your Hollow Pine Coffee order has been received!",
      text: "We've received your order #10442. Total: $43.50",
    });
    expect(woo.full.hardSignals).toContain("transactional_pattern");
    const promo = await typeOf(
      { subject: "Take 10% off your first order", text: "Coffee from $12.00. Shop now." },
      ["CATEGORY_PROMOTIONS"],
    );
    expect(promo.primaryType).toBe("promotional");
  });
});
