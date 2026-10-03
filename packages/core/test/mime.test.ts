import { describe, expect, it } from "vitest";
import {
  analyzeHeaders,
  classifyAutomated,
  classifyType,
  detectSecuritySensitive,
  extractContent,
  MimeParseError,
  parseMime,
} from "../src/index";
import { buildEml, readFixture } from "./helpers";

describe("parseMime", () => {
  it("decodes names, lower-cases addresses and measures HTML in UTF-8 bytes", async () => {
    const p = await parseMime(
      buildEml({
        from: "=?UTF-8?Q?Caf=C3=A9_Lumi=C3=A8re?= <Hello@Cafe.EXAMPLE>",
        to: "Owner <OWNER@Example.com>, undisclosed-recipients:;",
        subject: "=?UTF-8?B?w4l0w6k=?=",
        html: "<p>é€</p>",
        text: "é€",
      }),
    );
    expect(p.from).toEqual({ address: "hello@cafe.example", name: "Café Lumière" });
    expect(p.to).toEqual([{ address: "owner@example.com", name: "Owner" }]);
    expect(p.subject).toBe("Été");
    expect(p.html).toContain("<p>é€</p>");
    expect(p.htmlBytes).toBe(Buffer.byteLength(p.html ?? "", "utf8"));
    expect(p.date?.toISOString()).toBe("2026-09-25T12:00:00.000Z");
    expect(p.headers.find((h) => h.name === "subject")?.value).toBe("Été");
  });

  it("keeps ≤ 10 inline cid images ≤ 1 MB (no SVG), attachments as metadata, and flags calendar/AMP", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ).toString("base64");
    const parts: string[] = [];
    for (let i = 0; i < 12; i++) {
      parts.push(
        `--r\r\nContent-Type: image/png\r\nContent-ID: <Img${i}@X>\r\nContent-Transfer-Encoding: base64\r\n\r\n${png}\r\n`,
      );
    }
    parts.push(`--r\r\nContent-Type: image/svg+xml\r\nContent-ID: <vec@x>\r\n\r\n<svg/>\r\n`);
    parts.push(
      `--r\r\nContent-Type: image/png\r\nContent-ID: <big@x>\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.alloc(1_100_000, 1).toString("base64")}\r\n`,
    );
    parts.push(`--r\r\nContent-Type: text/x-amp-html\r\n\r\n<html amp4email></html>\r\n`);
    parts.push(
      `--r\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Eastern Standard Time:20261001T100000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    );
    parts.push(
      `--r\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n`,
    );
    const raw = [
      "From: a@b.example",
      "To: owner@example.com",
      "Subject: parts",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="r"',
      "",
      '--r\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<img src="cid:img0@x">\r\n' +
        parts.join("") +
        "--r--\r\n",
    ].join("\r\n");
    const p = await parseMime(raw);
    expect(p.inline).toHaveLength(10);
    expect(p.inline[0]).toMatchObject({ cid: "img0@x", mimeType: "image/png" });
    expect(p.inline.every((i) => i.content.byteLength <= 1024 * 1024)).toBe(true);
    expect(p.inline.some((i) => i.mimeType === "image/svg+xml")).toBe(false);
    expect(p.hasAmp).toBe(true);
    expect(p.hasCalendar).toBe(true);
    expect(p.calendarMethod).toBe("REQUEST");
    expect(p.calendarStart?.toISOString()).toBe("2026-10-01T14:00:00.000Z"); // Windows TZID mapped
    expect(p.attachments.find((a) => a.filename === "invoice.pdf")).toMatchObject({
      mimeType: "application/pdf",
      disposition: "attachment",
      size: 9,
    });
    expect(p.attachments.some((a) => a.mimeType === "text/x-amp-html")).toBe(false);
  });

  it("throws typed errors only when nothing usable can be parsed", async () => {
    await expect(parseMime("")).rejects.toMatchObject({
      name: "MimeParseError",
      code: "empty",
      ledgerReason: "parse_error",
    });
    await expect(parseMime("x".repeat(100), { maxBytes: 50 })).rejects.toMatchObject({
      code: "too_large",
      ledgerReason: "too_large",
    });
    await expect(parseMime("hello world this is not an email")).rejects.toBeInstanceOf(
      MimeParseError,
    );
    await expect(parseMime(new Uint8Array([0, 1, 2, 255, 254, 0]))).rejects.toBeInstanceOf(
      MimeParseError,
    );
    const hugeHeader = `X-Big: ${"a".repeat(600 * 1024)}\r\nFrom: a@b.example\r\n\r\nbody`;
    await expect(parseMime(hugeHeader)).rejects.toMatchObject({ code: "unparseable" });
    // Headers only, no body: still usable.
    await expect(parseMime("Subject: hi\r\nFrom: a@b.example\r\n")).resolves.toMatchObject({
      subject: "hi",
      html: null,
      text: null,
    });
  });

  it("never puts message content into error messages", async () => {
    try {
      await parseMime("secret-content-123 not an email");
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret");
    }
  });
});

describe("parseMime address headers: encoded-words never become addresses", () => {
  const parse = (headers: string[]) =>
    parseMime(
      [
        ...headers,
        "Subject: hi",
        "Date: Fri, 25 Sep 2026 12:00:00 +0000",
        "Content-Type: text/plain",
        "",
        "body",
        "",
      ].join("\r\n"),
    );

  it("drops a mailbox whose only address is inside an encoded-word (Q, B, comma, colon)", async () => {
    for (const from of [
      "=?utf-8?Q?=3Csecurity=40paypal.com=3E?=",
      "=?utf-8?Q?a=40b.com=2C_=3Csecurity=40paypal.com=3E?=",
      "=?utf-8?B?PHNlY3VyaXR5QHBheXBhbC5jb20+?=",
      "=?utf-8?Q?PayPal?= =?utf-8?Q?_=3Csecurity=40paypal.com=3E?=",
      "=?utf-8?Q?Team=3A_security=40paypal.com=3B?=",
      "Support <=?utf-8?Q?security=40paypal.com?=>",
      '"=?utf-8?Q?=3Csecurity=40paypal.com=3E?="',
    ]) {
      const p = await parse([`From: ${from}`, "To: owner@example.com"]);
      expect(p.from, from).toBeNull();
      const facts = analyzeHeaders(p, { userAddresses: ["security@paypal.com"] });
      expect(facts.fromDomain, from).toBeNull();
      expect(facts.fromSelf, from).toBe(false);
    }
  });

  it("keeps the literal <address> and decodes hostile structure only into the display name", async () => {
    const p = await parse([
      "From: =?utf-8?Q?PayPal=2C_=3Csecurity=40paypal.com=3E?= <Attacker@Evil.example>",
      "To: owner@example.com",
    ]);
    expect(p.from).toEqual({
      address: "attacker@evil.example",
      name: "PayPal, <security@paypal.com>",
    });
    expect(analyzeHeaders(p, { userAddresses: [] }).fromDomain).toBe("evil.example");
  });

  it("cannot fake fromSelf or a recipient with an encoded address", async () => {
    const p = await parse([
      "From: =?utf-8?Q?=3COwner=40Example.com=3E?=",
      "To: =?utf-8?Q?=3Cowner=40example.com=3E=2C_x?=, friend@example.org",
      "Cc: =?utf-8?B?UGF5UGFsIDxzZWN1cml0eUBwYXlwYWwuY29tPiwg?= <cc@example.org>",
      'Reply-To: =?utf-8?Q?=3Cphish=40evil.example=3E?=; "Help" <help@shop.example>',
    ]);
    expect(p.from).toBeNull();
    expect(p.to).toEqual([{ address: "friend@example.org", name: null }]);
    expect(p.cc).toEqual([{ address: "cc@example.org", name: "PayPal <security@paypal.com>," }]);
    expect(p.replyTo).toEqual([{ address: "help@shop.example", name: "Help" }]);
    const facts = analyzeHeaders(p, { userAddresses: ["owner@example.com"] });
    expect(facts.fromSelf).toBe(false);
    expect(facts.deliveredByBcc).toBe(true);
  });

  it("still parses ordinary lists: quoted commas, comments, groups, bare addresses, repeated headers", async () => {
    const p = await parse([
      "From: Jane Doe jane@x.example",
      'To: "Doe, John" <John@X.example>, jane@x.example (Jane), Team: a@x.example, b@x.example;',
      'To: "quoted@evil.example" real@x.example, <@relay.example:routed@x.example>',
      "Cc: undisclosed-recipients:;",
    ]);
    expect(p.from).toEqual({ address: "jane@x.example", name: "Jane Doe" });
    expect(p.to).toEqual([
      { address: "john@x.example", name: "Doe, John" },
      { address: "jane@x.example", name: "Jane" },
      { address: "a@x.example", name: null },
      { address: "b@x.example", name: null },
      { address: "real@x.example", name: "quoted@evil.example" },
      { address: "routed@x.example", name: null },
    ]);
    expect(p.cc).toEqual([]);
  });

  it("takes the first bare address, keeps quoted local parts, and drops extra angle brackets", async () => {
    const two = await parse(["From: attacker@evil.example security@paypal.com"]);
    expect(two.from).toEqual({ address: "attacker@evil.example", name: "security@paypal.com" });
    const facts = analyzeHeaders(two, { userAddresses: ["security@paypal.com"] });
    expect(facts.fromDomain).toBe("evil.example");
    expect(facts.fromSelf).toBe(false);

    const quoted = await parse([
      'From: "john doe"@example.com',
      'To: <"john doe"@example.com>, "=?utf-8?Q?a?="@evil.example',
      "Cc: <a@x.example> <b@y.example>",
    ]);
    expect(quoted.from).toEqual({ address: '"johndoe"@example.com', name: null });
    expect(analyzeHeaders(quoted, { userAddresses: [] }).fromDomain).toBe("example.com");
    expect(quoted.to).toEqual([{ address: '"johndoe"@example.com', name: null }]);
    expect(quoted.cc).toEqual([{ address: "a@x.example", name: "b@y.example" }]);
  });

  it("unquotes a quoted local part that is only atext, so it matches the unquoted mailbox", async () => {
    const p = await parse([
      'From: "x"@PayPal.com',
      'To: <"x"@paypal.com>, Bob <"first.last"@x.example>, "o\\\'b"@x.example',
      'Cc: "a b"@x.example, <"a@b"@evil.example>, <"a..b"@x.example>, <".a"@x.example>, <""@x.example>',
    ]);
    expect(p.from).toEqual({ address: "x@paypal.com", name: null });
    const facts = analyzeHeaders(p, { userAddresses: ["x@paypal.com"] });
    expect(facts.fromSelf).toBe(true);
    expect(facts.fromDomain).toBe("paypal.com");
    expect(p.to).toEqual([
      { address: "x@paypal.com", name: null },
      { address: "first.last@x.example", name: "Bob" },
      { address: "o'b@x.example", name: null },
    ]);
    // Local parts that genuinely need quoting keep their quotes.
    expect(p.cc).toEqual([
      { address: '"ab"@x.example', name: null },
      { address: '"a@b"@evil.example', name: null },
      { address: '"a..b"@x.example', name: null },
      { address: '".a"@x.example', name: null },
      { address: '""@x.example', name: null },
    ]);
  });

  it("keeps the quotes on an escaped backslash or a Unicode space/control/invisible", async () => {
    // Header text `"\\x"`: the local part is a literal backslash then x, not the mailbox x.
    const p = await parse([
      'From: "\\\\x"@paypal.com',
      'To: <"\\\\x"@paypal.com>',
      'Cc: "a\u3000b"@x.example, "a\u00a0b"@x.example, <"a\u0085b"@x.example>, "a\u200bb"@x.example',
    ]);
    expect(p.from).toEqual({ address: '"\\x"@paypal.com', name: null });
    expect(analyzeHeaders(p, { userAddresses: ["x@paypal.com"] }).fromSelf).toBe(false);
    expect(p.to).toEqual([{ address: '"\\\\x"@paypal.com', name: null }]);
    expect(p.cc.map((a) => a.address)).toEqual([
      '"ab"@x.example',
      '"ab"@x.example',
      '"a\u0085b"@x.example',
      '"a\u200bb"@x.example',
    ]);
  });
});

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fullPipeline(raw: Uint8Array | string): Promise<void> {
  let parsed;
  try {
    parsed = await parseMime(raw);
  } catch (e) {
    if (e instanceof MimeParseError) return; // the only error allowed to escape
    throw e;
  }
  const headers = analyzeHeaders(parsed, { userAddresses: ["owner@example.com"] });
  const content = extractContent(parsed, {
    receivedAt: new Date("2026-09-25T12:00:00Z"),
    userAddresses: ["owner@example.com"],
    fromDomain: headers.fromDomain,
  });
  const security = detectSecuritySensitive({ parsed, content, headers });
  classifyAutomated({
    parsed,
    headers,
    content,
    labelIds: ["INBOX"],
    priorContact: null,
    senderTemplateRepeats: false,
    security,
  });
  classifyType({
    parsed,
    headers,
    content,
    labelIds: ["INBOX"],
    security,
    prior: null,
    templateClassification: null,
  });
}

describe("malformed MIME (fuzz-ish): never throws uncaught, never hangs", () => {
  it("handles truncated boundaries, missing terminators and nested garbage", async () => {
    const cases = [
      'From: a@b.example\r\nContent-Type: multipart/alternative; boundary="zz"\r\n\r\n--zz\r\nContent-Type: text/html\r\n\r\n<p>Hello',
      'From: a@b.example\r\nContent-Type: multipart/mixed; boundary=""\r\n\r\n--\r\n--\r\n',
      "From: a@b.example\r\nContent-Type: multipart/mixed\r\n\r\nno boundary param",
      `From: a@b.example\r\nContent-Type: multipart/mixed; boundary="${"x".repeat(5000)}"\r\n\r\n--${"x".repeat(5000)}\r\n`,
      `From: a@b.example\r\n${Array.from({ length: 60 }, (_, i) => `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`).join("")}`,
      "From: a@b.example\r\nContent-Transfer-Encoding: base64\r\nContent-Type: text/html\r\n\r\n!!!!not base64!!!!",
      "From: a@b.example\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Type: text/html\r\n\r\n=ZZ=\r\n=",
      `From: ${"<".repeat(20000)}\r\nTo: ${",".repeat(20000)}\r\nSubject: =?utf-8?B?${"=".repeat(5000)}?=\r\n\r\nbody`,
      `Subject: x\r\nAuthentication-Results: mx.google.com; ${"(".repeat(20000)}\r\nDKIM-Signature: ${"h=a:".repeat(20000)}\r\nList-Unsubscribe: ${"<".repeat(20000)}\r\n\r\nx`,
      `From: a@b.example\r\nContent-Type: text/html\r\n\r\n${"<a href='https://x.example/".repeat(20000)}`,
    ];
    for (const raw of cases) {
      const t = performance.now();
      await fullPipeline(raw);
      expect(performance.now() - t, raw.slice(0, 60)).toBeLessThan(3000);
    }
  });

  it("survives random mutations of a real message", async () => {
    const base = new Uint8Array(readFixture("01-promo-retail"));
    const rand = rng(1234);
    const started = performance.now();
    for (let i = 0; i < 150; i++) {
      const buf = new Uint8Array(base);
      const edits = 1 + Math.floor(rand() * 40);
      for (let e = 0; e < edits; e++) {
        const pos = Math.floor(rand() * buf.length);
        const r = rand();
        if (r < 0.4) buf[pos] = Math.floor(rand() * 256);
        else if (r < 0.7)
          buf[pos] = [0x3c, 0x3e, 0x2d, 0x0a, 0x3d, 0x22][Math.floor(rand() * 6)] ?? 0x3c;
        else buf[pos] = 0;
      }
      const cut = rand() < 0.3 ? Math.floor(rand() * buf.length) : buf.length;
      await fullPipeline(buf.subarray(0, cut));
    }
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
