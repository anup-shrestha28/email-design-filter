import { describe, expect, it } from "vitest";
import {
  analyzeHeaders,
  canonicalMailbox,
  isNoReplyLocalPart,
  isOneClick,
  isSuspicious,
  parseAuthenticationResults,
  parseDkimSignature,
  parseListUnsubscribe,
  parseMime,
  summarizeAuth,
} from "../src/index";
import { buildEml } from "./helpers";

const GOOGLE_AR =
  "mx.google.com; dkim=pass header.i=@acme.example header.s=s1 header.b=abc; spf=pass (google.com: domain of b@mail.acme.example designates 1.2.3.4 as permitted sender) smtp.mailfrom=b@mail.acme.example; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.example";

describe("Authentication-Results (RFC 8601, topmost mx.google.com only)", () => {
  it("parses spf/dkim/dmarc, pass domains, header.from, policy and the SPF identity", () => {
    const a = parseAuthenticationResults([GOOGLE_AR]);
    expect(a).toMatchObject({
      found: true,
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      arc: "none",
      dkimPassDomains: ["acme.example"],
      dmarcHeaderFrom: "acme.example",
      dmarcPolicy: "reject",
      spfMailFromDomain: "acme.example",
    });
  });

  it("uses only the topmost mx.google.com header; a forged lower one is ignored", () => {
    const top =
      "mx.google.com; dkim=fail header.i=@acme.example; spf=softfail smtp.mailfrom=x@evil.example; dmarc=fail (p=QUARANTINE) header.from=acme.example";
    const forged =
      "mx.google.com; dkim=pass header.i=@acme.example; spf=pass smtp.mailfrom=acme.example; dmarc=pass header.from=acme.example";
    const a = parseAuthenticationResults([top, forged]);
    expect(a.dmarc).toBe("fail");
    expect(a.dkim).toBe("fail");
    expect(a.spf).toBe("softfail");
    expect(a.dmarcPolicy).toBe("quarantine");
  });

  it("ignores Authentication-Results from other authserv-ids, even when they come first", () => {
    const other =
      "mx.evil.example; dkim=pass header.i=@bank.example; dmarc=pass header.from=bank.example";
    const a = parseAuthenticationResults([other, GOOGLE_AR]);
    expect(a.dkimPassDomains).toEqual(["acme.example"]);
    expect(parseAuthenticationResults([other])).toMatchObject({
      found: false,
      dmarc: "unknown",
      dkim: "unknown",
    });
  });

  it("matches the authserv-id exactly (not a suffix) and case-insensitively", () => {
    expect(parseAuthenticationResults(["fake-mx.google.com; dmarc=pass"]).found).toBe(false);
    expect(
      parseAuthenticationResults(["MX.Google.COM; dmarc=pass header.from=a.example"]).found,
    ).toBe(true);
  });

  it("reads arc=pass and treats any passing DKIM signature as a DKIM pass", () => {
    const v =
      "mx.google.com; arc=pass (i=1 spf=pass spfdomain=list.example dkim=pass dkdomain=a.example); dkim=fail header.i=@a.example header.s=x; dkim=pass header.d=list.example header.s=y; spf=pass smtp.mailfrom=bounces@list.example; dmarc=fail (p=REJECT) header.from=a.example";
    const a = parseAuthenticationResults([v]);
    expect(a.arc).toBe("pass");
    expect(a.dkim).toBe("pass");
    expect(a.dkimPassDomains).toEqual(["list.example"]);
    expect(isSuspicious(a, "a.example")).toBe(false); // ARC pass excludes forwarded/list mail
  });

  it("keeps semicolons inside comments and quoted strings from splitting results", () => {
    const v =
      'mx.google.com; spf=pass (google.com; domain of "a;b"@x.example designates 1.2.3.4) smtp.mailfrom="a;b@x.example"; dmarc=pass (p=NONE; sp=NONE) header.from=x.example';
    const a = parseAuthenticationResults([v]);
    expect(a.spf).toBe("pass");
    expect(a.dmarc).toBe("pass");
    expect(a.dmarcPolicy).toBe("none");
  });

  it("maps unknown result tokens to 'unknown' and missing methods to 'none'", () => {
    const a = parseAuthenticationResults([
      "mx.google.com; dmarc=bestguesspass header.from=x.example",
    ]);
    expect(a.dmarc).toBe("unknown");
    expect(a.spf).toBe("none");
    expect(a.dkim).toBe("none");
  });

  it("summarises auth_result strictly on DMARC", () => {
    expect(summarizeAuth(parseAuthenticationResults([GOOGLE_AR]))).toBe("pass");
    expect(
      summarizeAuth(
        parseAuthenticationResults([
          "mx.google.com; dkim=pass header.i=@a.example; spf=pass smtp.mailfrom=a.example",
        ]),
      ),
    ).toBe("none");
    expect(
      summarizeAuth(
        parseAuthenticationResults(["mx.google.com; dkim=fail header.i=@a.example; spf=none"]),
      ),
    ).toBe("fail");
    expect(summarizeAuth(parseAuthenticationResults([]))).toBe("unknown");
  });

  it("flags suspicious only for DMARC fail + unaligned + no ARC pass", () => {
    const failUnaligned = parseAuthenticationResults([
      "mx.google.com; dkim=pass header.i=@evil.example; spf=pass smtp.mailfrom=b@evil.example; dmarc=fail header.from=bank.example",
    ]);
    expect(isSuspicious(failUnaligned, "bank.example")).toBe(true);
    // DMARC fail but DKIM aligned with From (e.g. strict alignment on a subdomain): not suspicious.
    const failAligned = parseAuthenticationResults([
      "mx.google.com; dkim=pass header.i=@bank.example; dmarc=fail header.from=bank.example",
    ]);
    expect(isSuspicious(failAligned, "bank.example")).toBe(false);
  });

  it("is linear on hostile input (deep parentheses, long values)", () => {
    const hostile = `mx.google.com; ${"(".repeat(50_000)}${"a".repeat(50_000)}`;
    const t = performance.now();
    parseAuthenticationResults([
      hostile,
      `mx.google.com; ${"dkim=pass header.d=a.example; ".repeat(5000)}`,
    ]);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("RFC 8058 one-click (https URI + exact Post value + DKIM h= covering both, passing)", () => {
  const lu = parseListUnsubscribe("<https://x.example/u?t=1>, <mailto:u@x.example>");
  const covering = parseDkimSignature(
    "v=1; d=x.example; s=s1; h=from:to:subject:list-unsubscribe:list-unsubscribe-post; bh=a; b=b",
  );

  it("is true when all conditions hold", () => {
    expect(isOneClick(lu, "List-Unsubscribe=One-Click", [covering], ["x.example"])).toBe(true);
  });

  it("requires h= to cover both headers (folding whitespace allowed)", () => {
    const partial = parseDkimSignature(
      "v=1; d=x.example; s=s1; h=from:to:list-unsubscribe; bh=a; b=b",
    );
    expect(isOneClick(lu, "List-Unsubscribe=One-Click", [partial], ["x.example"])).toBe(false);
    const folded = parseDkimSignature(
      "v=1; d=x.example; s=s1;\r\n\th=from:to:\r\n list-unsubscribe:list-unsubscribe-post; bh=a; b=b",
    );
    expect(folded.signedHeaders).toContain("list-unsubscribe-post");
    expect(isOneClick(lu, "List-Unsubscribe=One-Click", [folded], ["x.example"])).toBe(true);
  });

  it("requires the covering signature to be one Gmail verified (d= among dkim=pass domains)", () => {
    expect(isOneClick(lu, "List-Unsubscribe=One-Click", [covering], ["other.example"])).toBe(false);
    const sub = parseDkimSignature(
      "d=mail.x.example; s=s1; h=list-unsubscribe:list-unsubscribe-post",
    );
    expect(isOneClick(lu, "List-Unsubscribe=One-Click", [sub], ["x.example"])).toBe(true); // registrable match
  });

  it("requires the exact Post value and an https URI (http is ignored)", () => {
    expect(isOneClick(lu, "List-Unsubscribe=One-click", [covering], ["x.example"])).toBe(false);
    expect(isOneClick(lu, null, [covering], ["x.example"])).toBe(false);
    const httpOnly = parseListUnsubscribe("<http://x.example/u>, <mailto:u@x.example>");
    expect(httpOnly).toEqual({ https: [], mailto: ["mailto:u@x.example"] });
    expect(isOneClick(httpOnly, "List-Unsubscribe=One-Click", [covering], ["x.example"])).toBe(
      false,
    );
  });
});

describe("List-Unsubscribe parsing", () => {
  it("keeps header order, ignores whitespace inside brackets and tolerates missing brackets", () => {
    expect(
      parseListUnsubscribe("<mailto:a@x.example>, <https://x.example/u?a=1\r\n &b=2>"),
    ).toEqual({
      https: ["https://x.example/u?a=1&b=2"],
      mailto: ["mailto:a@x.example"],
    });
    expect(parseListUnsubscribe("https://x.example/u")).toEqual({
      https: ["https://x.example/u"],
      mailto: [],
    });
    expect(parseListUnsubscribe(null)).toBeNull();
    expect(parseListUnsubscribe("<javascript:alert(1)>")).toEqual({ https: [], mailto: [] });
  });
});

describe("analyzeHeaders", () => {
  async function facts(
    extra: string[],
    from = "Acme <news@acme.example>",
    to = "owner@example.com",
  ) {
    const parsed = await parseMime(buildEml({ from, to, headers: extra, text: "hi" }));
    return analyzeHeaders(parsed, { userAddresses: ["Owner@Example.com"] });
  }

  it("reads List-Id, Feedback-ID, Precedence and Auto-Submitted", async () => {
    const f = await facts([
      "List-Id: Weekly News <weekly.acme.example>",
      "Feedback-ID: 1:2:3:klaviyo",
      "Precedence: bulk",
      "Auto-Submitted: auto-generated (cron)",
    ]);
    expect(f.listId).toBe("weekly.acme.example");
    expect(f.feedbackId).toBe("1:2:3:klaviyo");
    expect(f.precedence).toBe("bulk");
    expect(f.autoSubmitted).toBe("auto-generated");
    expect(f.espPlatform).toBe("Klaviyo");
  });

  it("fingerprints platform and MTA separately (Braze on SES)", async () => {
    const f = await facts([
      "Return-Path: <010001-abc@us-east-1.amazonses.com>",
      "Feedback-ID: 1.us-east-1.xyz=:AmazonSES",
      "X-Braze-Campaign: 123",
    ]);
    expect(f.espPlatform).toBe("Braze");
    expect(f.espMta).toBe("Amazon SES");
    expect(f.espTransactional).toBe(true);
  });

  it("detects Klaviyo transactional streams from kt* selectors", async () => {
    const f = await facts([
      "X-Mailer: Klaviyo",
      "DKIM-Signature: v=1; d=acme.example; s=kt1; h=from:to; bh=a; b=b",
    ]);
    expect(f.dkimSelectors).toEqual(["kt1"]);
    expect(f.espTransactional).toBe(true);
  });

  it("computes fromDomain (registrable), no-reply, free-mail, BCC and self", async () => {
    const f = await facts(
      [],
      "Alerts <No-Reply@alerts.mail.acme.co.uk>",
      "someone-else@example.com",
    );
    expect(f.fromDomain).toBe("acme.co.uk");
    expect(f.isNoReply).toBe(true);
    expect(f.deliveredByBcc).toBe(true);
    const self = await facts([], "Me <owner+test@example.com>");
    expect(self.fromSelf).toBe(true);
    expect(self.deliveredByBcc).toBe(false);
    const friend = await facts([], "Sam <sam@gmail.com>");
    expect(friend.isFreemailSender).toBe(true);
  });

  it("detects mailing-list software and List-Post", async () => {
    const f = await facts(["X-Mailman-Version: 3.3.9", "List-Post: <mailto:l@lists.example>"]);
    expect(f.mailingListSoftware).toBe("Mailman");
    expect(f.listPost).toBe(true);
  });

  it("decodes RFC 2047 display names and subjects but not structured headers", async () => {
    const parsed = await parseMime(
      buildEml({
        from: "=?UTF-8?B?w4lsb2RpZQ==?= <E@X.example>",
        subject: "=?utf-8?q?Caf=C3=A9_ouvert?=",
        text: "x",
      }),
    );
    expect(parsed.from).toEqual({ address: "e@x.example", name: "Élodie" });
    expect(parsed.subject).toBe("Café ouvert");
  });
});

describe("sender helpers", () => {
  it("recognises no-reply local parts in several languages", () => {
    for (const lp of [
      "noreply",
      "no-reply",
      "do_not_reply",
      "donotreply+abc",
      "accounts-noreply",
      "ne-pas-repondre",
      "nao-responda",
    ]) {
      expect(isNoReplyLocalPart(lp), lp).toBe(true);
    }
    for (const lp of ["hello", "news", "replies", "support"])
      expect(isNoReplyLocalPart(lp), lp).toBe(false);
  });

  it("canonicalises Gmail dots / +tags and googlemail.com", () => {
    expect(canonicalMailbox("J.Doe+news@GoogleMail.com")).toBe("jdoe@gmail.com");
    expect(canonicalMailbox("first.last+x@acme.example")).toBe("first.last@acme.example");
  });
});
