import { describe, expect, it } from "vitest";
import {
  analyzeHeaders,
  classifyType,
  computeImportance,
  detectSecuritySensitive,
  extractContent,
  parseMime,
} from "../src/index";
import type { SenderPrior } from "../src/index";
import { analyze, RECEIVED, typeOf } from "./helpers";

const ld = (obj: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(obj)}</script></head><body><p>Details inside.</p></body></html>`;

function prior(overrides: Partial<SenderPrior> = {}): SenderPrior {
  return {
    typeOverride: null,
    majorityType: null,
    majorityShare: 0,
    emailCount: 0,
    readRate60d: null,
    emailsPerWeek: null,
    userImportanceBias: 0,
    muted: false,
    ...overrides,
  };
}

describe("rule 1 — schema.org", () => {
  it.each([
    [
      {
        "@context": "http://schema.org",
        "@type": "Order",
        orderNumber: "A1",
        orderStatus: "http://schema.org/OrderProcessing",
      },
      "transactional",
      "order",
    ],
    [{ "@type": "Order", orderStatus: "OrderInTransit" }, "transactional", "shipping"],
    [
      { "@type": "ParcelDelivery", trackingNumber: "1Z999AA10123456784" },
      "transactional",
      "shipping",
    ],
    [
      { "@type": "Invoice", paymentStatus: "http://schema.org/PaymentPastDue" },
      "transactional",
      "payment_failed",
    ],
    [{ "@type": "Invoice", paymentDueDate: "2026-10-01" }, "transactional", "invoice"],
    [{ "@type": "LodgingReservation", checkinDate: "2026-10-10" }, "transactional", "travel"],
    [
      {
        "@type": "EventReservation",
        reservationFor: { "@type": "Event", name: "Concert", startDate: "2026-10-10T20:00:00Z" },
      },
      "transactional",
      "ticket",
    ],
    [
      { "@type": "DiscountOffer", discountCode: "FALL10", description: "10% off" },
      "promotional",
      "coupon",
    ],
    [
      {
        "@type": "Event",
        name: "Launch",
        startDate: "2026-10-10T17:00:00Z",
        eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
      },
      "event",
      "webinar",
    ],
    [
      {
        "@graph": [
          { "@type": "Organization", name: "Acme" },
          { "@type": "ParcelDelivery", trackingNumber: "TBA123456789012" },
        ],
      },
      "transactional",
      "shipping",
    ],
  ])("%j → %s/%s", async (obj, type, subtype) => {
    const v = await typeOf({ subject: "Update", html: ld(obj) });
    expect(v).toMatchObject({ primaryType: type, subtype, typeSource: "rule" });
    expect(v.rule).toMatch(/^schema:/);
  });

  it("markup Order + DiscountOffer: transactional wins with a promotional secondary tag", async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify([{ "@type": "Order" }, { "@type": "DiscountOffer", discountCode: "NEXT15" }])}</script></head><body>Thanks</body></html>`;
    const v = await typeOf({ subject: "Order confirmed", html });
    expect(v).toMatchObject({
      primaryType: "transactional",
      subtype: "order",
      secondaryTags: ["promotional"],
    });
  });
});

function calendarEml(method: string, subject: string): string {
  return [
    "From: Cal <calendar-noreply@cal.example>",
    "To: owner@example.com",
    `Subject: ${subject}`,
    "Date: Fri, 25 Sep 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="c"',
    "",
    "--c",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Details",
    "--c",
    `Content-Type: text/calendar; charset=utf-8; method=${method}`,
    "",
    "BEGIN:VCALENDAR",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    "DTSTART:20261001T150000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "--c--",
    "",
  ].join("\r\n");
}

async function typeOfRaw(raw: string, labels: string[] = ["INBOX"]) {
  const parsed = await parseMime(raw);
  const headers = analyzeHeaders(parsed, { userAddresses: ["owner@example.com"] });
  const content = extractContent(parsed, {
    receivedAt: RECEIVED,
    userAddresses: ["owner@example.com"],
    fromDomain: headers.fromDomain,
  });
  const security = detectSecuritySensitive({ parsed, content, headers });
  return {
    v: classifyType({
      parsed,
      headers,
      content,
      labelIds: labels,
      security,
      prior: null,
      templateClassification: null,
    }),
    parsed,
    content,
  };
}

describe("rule 2 — text/calendar", () => {
  it("an invitation is an event; its DTSTART becomes the deadline", async () => {
    const { v, parsed, content } = await typeOfRaw(calendarEml("REQUEST", "Invitation: Sync"));
    expect(v).toMatchObject({ primaryType: "event", subtype: "invitation", rule: "calendar" });
    expect(parsed.calendarMethod).toBe("REQUEST");
    expect(content.deadlineAt?.toISOString()).toBe("2026-10-01T15:00:00.000Z");
  });

  it("an attendee REPLY is an activity notification", async () => {
    const { v } = await typeOfRaw(calendarEml("REPLY", "Accepted: Sync"));
    expect(v).toMatchObject({ primaryType: "notification", subtype: "activity" });
  });
});

describe("rule 3 — security", () => {
  it("OTP → account_security/verification_code", async () => {
    const v = await typeOf({
      from: "Acme <no-reply@acme.example>",
      subject: "Your Acme code",
      text: "Your verification code is 739104. It expires in 10 minutes.",
    });
    expect(v).toMatchObject({
      primaryType: "account_security",
      subtype: "verification_code",
      rule: "security:otp",
    });
  });
});

describe("rules 4–6 — transactional", () => {
  it("billing keyword + amount → receipt", async () => {
    const v = await typeOf({
      subject: "Your receipt from Acme",
      text: "Thanks for your payment of $12.00 on September 25.",
    });
    expect(v).toMatchObject({ primaryType: "transactional", subtype: "receipt" });
  });

  it("payment failure needs no amount", async () => {
    const v = await typeOf({
      subject: "Your card was declined",
      text: "Please update your payment method to keep your plan.",
    });
    expect(v).toMatchObject({ primaryType: "transactional", subtype: "payment_failed" });
  });

  it("'20% off your order' with a price is not a receipt", async () => {
    const v = await typeOf(
      {
        subject: "Take 20% off your order",
        text: "Everything from $50. Shop now before it's gone.",
      },
      ["CATEGORY_PROMOTIONS"],
    );
    expect(v.primaryType).toBe("promotional");
  });

  it("shipping keyword + carrier → shipping, even with an order total", async () => {
    const v = await typeOf({
      subject: "Good news",
      text: "Your package is on its way with USPS. Order total $40.00.",
    });
    expect(v).toMatchObject({ primaryType: "transactional", subtype: "shipping" });
  });

  it("travel confirmation with a booking reference → travel", async () => {
    const v = await typeOf({
      subject: "Your booking confirmation",
      text: "Booking reference: QX7P2L. Check-in is 3 PM.",
    });
    expect(v).toMatchObject({ primaryType: "transactional", subtype: "travel" });
  });

  it("a travel promo is not a booking", async () => {
    const v = await typeOf(
      { subject: "Flights to Lisbon from $99 – sale ends Friday", text: "Book now." },
      ["CATEGORY_PROMOTIONS"],
    );
    expect(v.primaryType).toBe("promotional");
  });
});

describe("rules 7–9 — social, community, survey (+ event)", () => {
  it("a known social network domain → social", async () => {
    expect(
      (
        await typeOf({
          from: "LinkedIn <notifications-noreply@linkedin.com>",
          subject: "You appeared in 9 searches",
          text: "See who's looking",
        })
      ).primaryType,
    ).toBe("social");
  });

  it("List-Post / mailing-list software → community; dev-tool List-Id mail is not", async () => {
    const list = await typeOf({
      from: "A <a@home.example>",
      subject: "[dev] Re: build flags",
      headers: ["List-Id: <dev.lists.example>", "List-Post: <mailto:dev@lists.example>"],
      text: "Try -O2.",
    });
    expect(list).toMatchObject({ primaryType: "community", subtype: "mailing_list" });
    const gh = await typeOf({
      from: "Bot <notifications@github.com>",
      subject: "[acme/x] Build failed",
      headers: ["List-Id: <x.acme.github.com>", "List-Post: <mailto:reply@github.com>"],
      text: "The build failed.",
    });
    expect(gh.primaryType).not.toBe("community");
  });

  it("survey wording in the subject → survey", async () => {
    expect(
      (await typeOf({ subject: "Tell us how we did", text: "Take our 2-minute survey." }))
        .primaryType,
    ).toBe("survey");
  });

  it("webinar / event wording → event (subtypes webinar, event_reminder)", async () => {
    expect(
      await typeOf({ subject: "Join our live webinar next Tuesday", text: "Register now." }),
    ).toMatchObject({ primaryType: "event", subtype: "webinar" });
    expect(
      await typeOf({ subject: "Reminder: the summit starts tomorrow", text: "Doors open at 9." }),
    ).toMatchObject({ primaryType: "event", subtype: "event_reminder" });
  });
});

describe("rule 10 — promotional", () => {
  it("promo tokens in the subject → promotional/sale", async () => {
    expect(
      await typeOf({ subject: "Flash sale: 40% off everything", text: "Shop now." }),
    ).toMatchObject({ primaryType: "promotional", subtype: "sale" });
  });

  it("CATEGORY_PROMOTIONS alone → promotional (lower confidence)", async () => {
    const v = await typeOf(
      { subject: "Fresh picks for autumn", text: "Our favourite pieces this season." },
      ["CATEGORY_PROMOTIONS"],
    );
    expect(v.primaryType).toBe("promotional");
    expect(v.typeConfidence).toBeLessThan(0.8);
  });

  it("a Klaviyo km* selector → promotional", async () => {
    const v = await typeOf({
      subject: "Something for the weekend",
      headers: [
        "X-Mailer: Klaviyo",
        "DKIM-Signature: v=1; d=acme.example; s=km2; h=from:to; bh=a; b=b",
      ],
      text: "Take a look.",
    });
    expect(v).toMatchObject({ primaryType: "promotional", rule: "promo:klaviyo-km" });
  });

  it("a Substack newsletter in the Promotions tab stays a newsletter", async () => {
    const v = await typeOf(
      {
        subject: "Notes on slow cities",
        headers: [
          "Return-Path: <bounce@mg.substack.com>",
          "List-Unsubscribe: <https://acme.substack.com/action/disable_email>",
        ],
        text: "An essay about walking.",
      },
      ["CATEGORY_PROMOTIONS"],
    );
    expect(v).toMatchObject({ primaryType: "newsletter", rule: "newsletter:platform" });
  });
});

describe("rules 11–14 — newsletter, lifecycle, updates, notices, notifications", () => {
  it("newsletter subject + list headers → newsletter/digest", async () => {
    expect(
      await typeOf({
        subject: "The Friday digest",
        headers: ["List-Unsubscribe: <https://acme.example/u>"],
        text: "Top stories this week.",
      }),
    ).toMatchObject({ primaryType: "newsletter", subtype: "digest" });
  });

  it.each([
    ["Welcome to Acme!", "welcome"],
    ["We miss you", "re_engagement"],
    ["Get started with Acme in 3 steps", "onboarding"],
    ["Your trial ends tomorrow", "trial_ending"],
  ])("lifecycle: %s → %s", async (subject, subtype) => {
    expect(await typeOf({ subject, text: "Hi there." })).toMatchObject({
      primaryType: "lifecycle",
      subtype,
    });
  });

  it.each([
    ["What's new in Acme", "product_update", "feature"],
    ["Acme v2.4 release notes", "product_update", "release_notes"],
    ["Changes to your plan", "account_notice", "plan_change"],
    ["We're updating our privacy policy", "account_notice", "privacy"],
    ["Updates to our Terms of Service", "account_notice", "terms"],
    // A lapsing subscription is a plan notice, urgency words or not (Atlassian billing notice).
    ["Your subscription will be deactivated soon", "account_notice", "plan_change"],
    ["Last chance: your subscription will be deactivated soon", "account_notice", "plan_change"],
    ["Don’t miss this: your plan has been suspended", "account_notice", "plan_change"],
    ["Add payment details to keep your subscription", "account_notice", "plan_change"],
  ])("updates: %s → %s/%s", async (subject, type, subtype) => {
    expect(await typeOf({ subject, text: "Details below." })).toMatchObject({
      primaryType: type,
      subtype,
    });
  });

  it.each([
    "Last chance: 30% off everything",
    "Last chance to save 20% before your plan will renew",
    "Don't miss our flash sale",
    "Limited time: free shipping on your subscription box",
  ])("urgency with a real offer stays promotional: %s", async (subject) => {
    expect(await typeOf({ subject, text: "Shop the collection today." })).toMatchObject({
      primaryType: "promotional",
    });
  });

  it("a footer privacy-policy link is not an account notice", async () => {
    const v = await typeOf({
      subject: "Hello",
      text: "Nice to see you. ".repeat(60) + " Privacy policy | Terms of service",
    });
    expect(v.primaryType).not.toBe("account_notice");
  });

  it("auto-generated + activity words → notification (activity / reminder / mention)", async () => {
    expect(
      await typeOf({
        from: "Acme <noreply@acme.example>",
        subject: "Your monthly report is ready",
        text: "Download it from your dashboard.",
      }),
    ).toMatchObject({ primaryType: "notification", subtype: "activity" });
    expect(
      await typeOf({
        from: "Acme <noreply@acme.example>",
        subject: "Reminder: task due tomorrow",
        text: "Finish the draft.",
      }),
    ).toMatchObject({ primaryType: "notification", subtype: "reminder" });
    expect(
      await typeOf({
        from: "Acme <noreply@acme.example>",
        subject: "Kim mentioned you in a comment",
        text: "@you please review.",
      }),
    ).toMatchObject({ primaryType: "notification", subtype: "mention" });
  });
});

describe("rules 15–16 — sender prior, template cache, Claude", () => {
  const vague = { subject: "Hello", text: "Some words here." };

  it("the user's override wins over rules and is labelled 'user'", async () => {
    const v = await typeOf(
      { subject: "Flash sale: 40% off", text: "Shop now." },
      ["INBOX"],
      prior({ typeOverride: "newsletter" }),
    );
    expect(v).toMatchObject({
      primaryType: "newsletter",
      typeSource: "user",
      typeConfidence: 1,
      needsLlm: false,
    });
  });

  it("an override never hides security-sensitive mail", async () => {
    const v = await typeOf(
      {
        from: "Acme <no-reply@acme.example>",
        subject: "Your code",
        text: "Your verification code is 739104.",
      },
      ["INBOX"],
      prior({ typeOverride: "promotional" }),
    );
    expect(v.primaryType).toBe("account_security");
  });

  it("majority ≥ 80% over ≥ 5 emails → sender_prior; below that → Claude", async () => {
    expect(
      await typeOf(
        vague,
        ["INBOX"],
        prior({ majorityType: "newsletter", majorityShare: 0.85, emailCount: 6 }),
      ),
    ).toMatchObject({ primaryType: "newsletter", typeSource: "sender_prior" });
    expect(
      await typeOf(
        vague,
        ["INBOX"],
        prior({ majorityType: "newsletter", majorityShare: 0.75, emailCount: 20 }),
      ),
    ).toMatchObject({ typeSource: "pending", needsLlm: true });
    expect(
      await typeOf(
        vague,
        ["INBOX"],
        prior({ majorityType: "newsletter", majorityShare: 1, emailCount: 4 }),
      ),
    ).toMatchObject({ typeSource: "pending" });
  });

  it("a Claude security label cached on a template can't reach 'high' without DMARC, even once the sender prior takes over", async () => {
    // One prompt-injected email gets Claude's account_security label, cached on its template.
    // Later emails of the template get it from the cache, and each one adds account_security to
    // the sender's type distribution, so after a few the sender prior (step 15) takes over.
    const a = await analyze(vague);
    expect(a.headers.authResult).not.toBe("pass");
    const importanceOf = (v: ReturnType<typeof classifyType>, p: SenderPrior | null) =>
      computeImportance({
        primaryType: v.primaryType,
        subtype: v.subtype,
        typeSource: v.typeSource,
        securitySensitive: a.security.securitySensitive,
        suspicious: a.headers.suspicious,
        authResult: a.headers.authResult,
        labelIds: a.labelIds,
        receivedAt: RECEIVED,
        now: RECEIVED,
        deals: a.content.deals,
        deadlineAt: a.content.deadlineAt,
        prior: p,
      });
    const templateClassification = { primaryType: "account_security" as const, subtype: "security_alert" };
    const cached = classifyType({ ...a, prior: null, templateClassification });
    expect(cached).toMatchObject({ primaryType: "account_security", typeSource: "template_cache" });
    expect(importanceOf(cached, null)).toMatchObject({ level: "normal" });

    const p = prior({ majorityType: "account_security", majorityShare: 0.8, emailCount: 5 });
    const viaPrior = classifyType({ ...a, prior: p, templateClassification });
    expect(viaPrior).toMatchObject({ primaryType: "account_security", typeSource: "sender_prior" });
    const imp = importanceOf(viaPrior, p);
    expect(imp).toMatchObject({ score: 59, level: "normal" });
    expect(imp.reasons).toContain("guardrail:dmarc_required");
  });

  it("the per-template cache is used before asking Claude", async () => {
    const a = await analyze(vague);
    const v = classifyType({
      ...a,
      prior: null,
      templateClassification: { primaryType: "product_update", subtype: "feature" },
    });
    expect(v).toMatchObject({
      primaryType: "product_update",
      subtype: "feature",
      typeSource: "template_cache",
      needsLlm: false,
    });
  });

  it("otherwise pending with a best-effort provisional type", async () => {
    expect(await typeOf(vague, ["CATEGORY_UPDATES"])).toMatchObject({
      primaryType: "notification",
      typeSource: "pending",
      needsLlm: true,
    });
    expect(await typeOf(vague, ["INBOX"])).toMatchObject({
      primaryType: "other",
      typeSource: "pending",
      needsLlm: true,
    });
  });
});
