/**
 * How a security-sensitive email (sign-in code, password reset, security alert) appears in the
 * inbox list (DESIGN.md §7.4): subject, sender and time only, the content marked hidden, no score,
 * deal or fonts, and a suspicious one flagged. Items come from the real listInbox query over
 * emails stored through the real pipeline store; the row is rendered in a DOM.
 */
import { redactSensitive } from "@edf/core";
import { afterAll, describe, expect, it } from "vitest";
import { InboxRow } from "@/components/email/inbox-row";
import type { getPool as getAppPool } from "@/server/db";
import { DEFAULT_FILTERS } from "@/lib/filters";
import type { InboxItem } from "@/server/queries/types";
import { HAS_DB } from "../support/env";
import { appPool } from "../support/db";
import { render } from "../support/render";
import { account, email, type Account } from "./fixtures";

/** A security alert as the pipeline stores it (analyze.ts: sensitive → redacted subject, no content). */
function securityAlert(over: Parameters<typeof email>[2] = {}): Parameters<typeof email>[2] {
  const subject = redactSensitive("Your sign-in code is 482913");
  return {
    subject,
    fromAddress: "no-reply@accounts.bank.example",
    fromName: "Bank Security",
    snippet: null,
    labelIds: ["INBOX", "UNREAD", "CATEGORY_UPDATES"],
    securitySensitive: true,
    isSubscription: false,
    subscriptionScore: 10,
    primaryType: "account_security",
    subtype: "security_alert",
    importance: "high",
    importanceScore: 80,
    importanceReasons: ["type:security_alert"],
    oneClickUnsubscribe: false,
    espPlatform: null,
    trackerCount: 0,
    utmCampaign: null,
    designStatus: "skipped",
    designSource: "none",
    designAiState: "not_applicable",
    designScore: null,
    designBand: null,
    designCapped: null,
    designProvisional: null,
    designIssues: [],
    designConfidence: null,
    fontSource: "none",
    fontFamilies: [],
    usesWebFonts: false,
    deals: [],
    searchText: `${subject} Bank Security no-reply@accounts.bank.example`,
    sender: {
      address: "no-reply@accounts.bank.example",
      displayName: "Bank Security",
      domain: "accounts.bank.example",
      espPlatform: null,
      listUnsubscribe: null,
      oneClick: false,
      authSummary: { trust: "trusted" },
    },
    templateSimhash: null,
    analysis: null,
    ...over,
  };
}

describe.skipIf(!HAS_DB)("inbox row: security-sensitive mail (DOM)", () => {
  const pool = appPool();
  let appPoolOf: typeof getAppPool | null = null;

  afterAll(async () => {
    await pool.end();
    await (await appPoolOf?.())?.end();
  });

  async function listed(a: Account, id: string): Promise<InboxItem> {
    const mod = await import("@/server/queries/inbox");
    appPoolOf = (await import("@/server/db")).getPool;
    const page = await mod.listInbox(a.user.userId, { ...DEFAULT_FILTERS, scope: "all" });
    const item = page.items.find((i) => i.id === id);
    if (!item) throw new Error("email not listed");
    return item;
  }

  it("shows subject, sender and time; the content is marked hidden; no score, deal or fonts", async () => {
    const a = await account(pool, "friend");
    const id = await email(pool, a, securityAlert());
    const item = await listed(a, id);
    expect(item).toMatchObject({ securitySensitive: true, snippet: null, deal: null, fontFamilies: [] });
    const r = await render(<InboxRow item={item} />);
    const text = r.container.textContent ?? "";

    expect(text).toContain("Bank Security");
    expect(text).toContain(item.subject);
    expect(text).not.toContain("482913");
    expect(text).toContain("Security email — content hidden");
    expect(r.container.querySelector("time")?.getAttribute("dateTime")).toBe(item.receivedAt);
    // The design chip explains itself and never shows a number.
    const chip = r.container.querySelector('[title^="Security emails are never rendered"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).not.toMatch(/\d/);
    expect(r.container.querySelector('[role="img"][aria-label^="Design score"]')).toBeNull();
    // Unread is announced, and the row links to the email's page.
    expect(text).toContain("(unread)");
    expect(r.container.querySelector("a")?.getAttribute("href")).toBe(`/email/${id}?back=%2Finbox`);
  });

  it("never shows a snippet for security mail, even one that reached the database", async () => {
    const a = await account(pool, "friend");
    const id = await email(pool, a, securityAlert({ snippet: "Use 482913 to sign in. Don't share this code." }));
    const item = await listed(a, id);
    expect(item.snippet).toBeNull();
    const r = await render(<InboxRow item={item} />);
    expect(r.container.textContent).not.toContain("482913");
    expect(r.container.textContent).toContain("Security email — content hidden");
  });

  it("a suspicious security email is flagged with a labelled icon", async () => {
    const a = await account(pool, "friend");
    const id = await email(pool, a, securityAlert({ suspicious: true, authResult: "fail" }));
    const item = await listed(a, id);
    expect(item.suspicious).toBe(true);
    const r = await render(<InboxRow item={item} compact />);
    expect(r.container.querySelector('[aria-label="Suspicious"]')).not.toBeNull();
    expect(r.container.textContent).toContain("Security email — content hidden");
  });

  it("a regular promotional email shows its snippet and score instead", async () => {
    const a = await account(pool, "friend");
    const id = await email(pool, a, { designScore: 81, designBand: "good", designProvisional: false, designSource: "render" });
    const item = await listed(a, id);
    const r = await render(<InboxRow item={item} />);
    const text = r.container.textContent ?? "";
    expect(text).toContain("Our autumn sale…");
    expect(text).not.toContain("content hidden");
    expect(r.container.querySelector('[role="img"][aria-label="Design score 81, Solid"]')).not.toBeNull();
  });
});
