/**
 * Pure analysis (no database): the drain may analyse one message twice (after a prior-contact
 * check); the costly static design extraction must run only once per message.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseMime } from "@edf/core";
import type { GmailMessageMeta } from "@edf/core/types";
import type { DesignFeatures } from "@edf/design";
import { analyzeMessage, prepareMessage, type AnalyzeInput } from "../src/analyze";

const FIXTURES = new URL("../../../fixtures/emails/", import.meta.url);

describe("analyzeMessage", () => {
  it("reuses the static design extraction when the same message is analysed again", async () => {
    const parsed = await parseMime(new Uint8Array(await readFile(new URL("01-promo-retail.eml", FIXTURES))));
    const meta = {
      id: "m1",
      threadId: "m1",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      snippet: "",
      historyId: "5000",
      internalDate: new Date("2026-09-25T14:02:15Z"),
      sizeEstimate: 4000,
    } as unknown as GmailMessageMeta;
    const prep = prepareMessage(parsed, meta, ["owner@example.com"]);
    if (prep.kind !== "ok") throw new Error("fixture skipped");
    const input = (priorContact: boolean | null): AnalyzeInput => ({
      parsed,
      meta,
      mailboxId: "mb",
      userId: "u",
      userAddresses: ["owner@example.com"],
      prior: null,
      senderBlockedPersonal: false,
      priorContact,
      template: null,
      now: new Date("2026-09-26T00:00:00Z"),
    });
    const first = analyzeMessage(input(null), prep.prepared);
    expect(prep.prepared.staticDesign).toBeDefined();
    const second = analyzeMessage(input(false), prep.prepared);
    if (first.kind !== "store" || second.kind !== "store") throw new Error("expected store");
    // Same object, not a recomputed copy.
    const staticOf = (r: typeof first) => (r.record.analysis?.features as DesignFeatures | undefined)?.static;
    expect(staticOf(second)).toBeDefined();
    expect(staticOf(second)).toBe(staticOf(first));
    expect(staticOf(second)).toBe(prep.prepared.staticDesign?.static);
  });

  it("an email inheriting a flagged (prompt-injection) template review is 'flagged', like designColumnsFor", async () => {
    const { baseAi, baseRender } = await import("../../design/test/helpers/factory");
    const parsed = await parseMime(new Uint8Array(await readFile(new URL("01-promo-retail.eml", FIXTURES))));
    const meta = {
      id: "m2",
      threadId: "m2",
      labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
      snippet: "",
      historyId: "5001",
      internalDate: new Date("2026-09-25T14:02:15Z"),
      sizeEstimate: 4000,
    } as unknown as GmailMessageMeta;
    const prep = prepareMessage(parsed, meta, ["owner@example.com"]);
    if (prep.kind !== "ok") throw new Error("fixture skipped");
    const now = new Date("2026-09-26T00:00:00Z");
    const input = (template: AnalyzeInput["template"]): AnalyzeInput => ({
      parsed,
      meta,
      mailboxId: "mb",
      userId: "u",
      userAddresses: ["owner@example.com"],
      prior: null,
      senderBlockedPersonal: false,
      priorContact: null,
      template,
      now,
    });
    const own = analyzeMessage(input(null), prep.prepared);
    if (own.kind !== "store") throw new Error("expected store");
    const ownFeatures = own.record.analysis!.features as DesignFeatures;
    const stateWith = (ai: DesignFeatures["ai"]) => {
      const sample: DesignFeatures = { ...ownFeatures, render: baseRender(), renderSource: "render", ai };
      const r = analyzeMessage(
        input({ classification: null, exemplar: { emailId: "sample", renderedAt: new Date("2026-09-20T00:00:00Z"), features: sample }, seenCount: 2 }),
        prep.prepared,
      );
      if (r.kind !== "store") throw new Error("expected store");
      expect(r.record.designSource).toBe("template");
      return r.record.designAiState;
    };
    expect(stateWith(baseAi())).toBe("from_template");
    expect(stateWith(baseAi({ flags: { suspected_prompt_injection: true } }))).toBe("flagged");
    expect(stateWith(baseAi({ injectionPatternHit: true }))).toBe("flagged");
    expect(stateWith(null)).toBe("pending");
  });
});
