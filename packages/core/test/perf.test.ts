import { describe, expect, it } from "vitest";
import {
  analyzeHeaders,
  buildTrustBadge,
  classifyAutomated,
  classifyType,
  computeImportance,
  detectSecuritySensitive,
  extractContent,
  parseMime,
} from "../src/index";
import { readFixture } from "./helpers";

/** The retail promo fixture grown to ~90 KB of HTML with realistic product rows. */
function bigPromo(): string {
  const raw = readFixture("01-promo-retail").toString("utf8");
  const row = (i: number) =>
    `<tr><td class="pad" style="padding:16px 40px;"><table role="presentation" width="100%"><tr>` +
    `<td width="45%"><a href="https://trk.klaviyomail.com/ls/click?upn=p${i}&amp;u=https%3A%2F%2Fnorthwind-outfitters.com%2Fp%2F${i}"><img src="https://cdn.northwind-outfitters.com/products/item-${i}.jpg" width="240" height="240" alt="Trail jacket in colour ${i}" style="display:block;width:100%;height:auto;"></a></td>` +
    `<td style="padding-left:16px;"><h2 style="font-size:18px;margin:0 0 6px;">Alpine trail jacket no. ${i}</h2>` +
    `<p style="font-size:15px;line-height:1.5;margin:0 0 10px;">Windproof, water-resistant and packable, with taped seams and a two-way zip. Now 30% off with code AUTUMN30 until midnight.</p>` +
    `<table role="presentation"><tr><td style="border-radius:6px;background:#1d4f3a;"><a class="btn" href="https://trk.klaviyomail.com/ls/click?upn=b${i}" style="display:inline-block;padding:10px 18px;color:#fff;text-decoration:none;">Shop now</a></td></tr></table></td>` +
    `</tr></table></td></tr>`;
  let rows = "";
  for (let i = 0; rows.length < 86_000; i++) rows += row(i);
  return raw.replace('<tr><td class="pad footer"', `${rows}<tr><td class="pad footer"`);
}

async function runOnce(raw: string): Promise<void> {
  const receivedAt = new Date("2026-09-25T14:02:15Z");
  const labelIds = ["INBOX", "CATEGORY_PROMOTIONS"];
  const parsed = await parseMime(raw);
  const headers = analyzeHeaders(parsed, { userAddresses: ["owner@example.com"] });
  const content = extractContent(parsed, {
    receivedAt,
    userAddresses: ["owner@example.com"],
    fromDomain: headers.fromDomain,
  });
  const security = detectSecuritySensitive({ parsed, content, headers });
  const automated = classifyAutomated({
    parsed,
    headers,
    content,
    labelIds,
    priorContact: null,
    senderTemplateRepeats: false,
    security,
  });
  const type = classifyType({
    parsed,
    headers,
    content,
    labelIds,
    security,
    prior: null,
    templateClassification: null,
  });
  computeImportance({
    primaryType: type.primaryType,
    subtype: type.subtype,
    typeSource: type.typeSource,
    securitySensitive: security.securitySensitive,
    suspicious: headers.suspicious,
    authResult: headers.authResult,
    labelIds,
    receivedAt,
    now: receivedAt,
    deals: content.deals,
    deadlineAt: content.deadlineAt,
    prior: null,
  });
  buildTrustBadge({
    headers,
    content,
    isSubscription: automated.isSubscription,
    primaryType: type.primaryType,
    visibleUnsubscribe: null,
  });
}

describe("performance smoke (FREE-TIER.md §7: ≈ 0.1 CPU-s per email)", () => {
  it("parse + extract + classify of a 90 KB promo takes < 150 ms", async () => {
    const raw = bigPromo();
    const parsed = await parseMime(raw);
    expect(parsed.htmlBytes).toBeGreaterThan(85_000);
    expect(parsed.htmlBytes).toBeLessThan(110_000);
    await runOnce(raw); // warm-up (module init, JIT)
    await runOnce(raw);
    // CPU time of this thread (the FREE-TIER budget is CPU-seconds); robust to parallel workers.
    const cpuMs = (): number => {
      const u = process.threadCpuUsage ? process.threadCpuUsage() : process.cpuUsage();
      return (u.user + u.system) / 1000;
    };
    const times: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < 5; i++) {
      const c = cpuMs();
      const t = performance.now();
      await runOnce(raw);
      wall.push(performance.now() - t);
      times.push(cpuMs() - c);
    }
    times.sort((a, b) => a - b);
    wall.sort((a, b) => a - b);
    expect(times[2] as number).toBeLessThan(150);
    expect(wall[0] as number).toBeLessThan(1000); // sanity bound even on a saturated CI box
  });
});
