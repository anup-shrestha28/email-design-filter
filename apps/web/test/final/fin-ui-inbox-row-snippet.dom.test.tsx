/**
 * R1-46: the inbox row labelled any email with a null snippet "Security email — content hidden".
 * Gmail can leave the snippet out for ordinary mail (an image-only promo), so the label now follows
 * `securitySensitive`, and an ordinary email with no snippet shows just its subject.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InboxRow } from "@/components/email/inbox-row";
import type { InboxItem } from "@/server/queries/types";
import { cleanup, render } from "../support/render";

afterEach(cleanup);

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: "e1",
  receivedAt: new Date().toISOString(),
  subject: "Autumn lookbook",
  snippet: null,
  fromName: "Shop",
  fromAddress: "news@shop.example",
  senderId: "s1",
  senderDomain: "shop.example",
  primaryType: "promotion",
  typeGroup: "promotions",
  subtype: null,
  typeSource: "rules",
  importance: "low",
  importanceReasons: [],
  design: {
    status: "pending",
    source: "none",
    aiState: "pending",
    score: null,
    band: null,
    provisional: false,
    capped: false,
    issues: [],
    confidence: null,
  },
  deal: null,
  isUnread: false,
  openedInApp: false,
  done: false,
  pinned: false,
  starred: false,
  suspicious: false,
  securitySensitive: false,
  isSubscription: true,
  fontFamilies: [],
  trackerCount: 0,
  ...over,
}) as InboxItem;

describe("inbox row snippet", () => {
  it("an ordinary email with no snippet isn't labelled a security email", async () => {
    const r = await render(<InboxRow item={item({ snippet: null, securitySensitive: false })} />);
    const text = r.container.querySelector("a")?.textContent ?? "";
    expect(text).toContain("Autumn lookbook");
    expect(text).not.toContain("Security email");
    expect(text).not.toContain(" — ");
  });

  it("a security-sensitive email is labelled, whatever the snippet says", async () => {
    const r = await render(<InboxRow item={item({ snippet: "Use 482913", securitySensitive: true })} />);
    const text = r.container.querySelector("a")?.textContent ?? "";
    expect(text).toContain("Security email — content hidden");
    expect(text).not.toContain("482913");
  });

  it("an ordinary email shows its snippet", async () => {
    const r = await render(<InboxRow item={item({ snippet: "New arrivals inside" })} />);
    expect(r.container.querySelector("a")?.textContent).toContain(" — New arrivals inside");
  });
});
