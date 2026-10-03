import { describe, expect, it } from "vitest";
import {
  decodeEncodedWords,
  decodeSnippetEntities,
  metaFromGmailMessage,
  parseAddressList,
  parseMailDate,
  parseParams,
  parsedFromGmailPayload,
  type FetchAttachment,
  type GmailMessage,
  type GmailMessagePart,
} from "../src/index";

const b64 = (s: string | Buffer) =>
  (typeof s === "string" ? Buffer.from(s, "utf8") : s).toString("base64url");
const noFetch: FetchAttachment = async () => {
  throw new Error("unexpected attachment fetch");
};

describe("MIME header helpers", () => {
  it("decodes RFC 2047 encoded-words (B and Q, adjacent words, split multi-byte chars)", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SGVsbG8g8J+YgA==?=")).toBe("Hello 😀");
    expect(decodeEncodedWords("=?iso-8859-1?Q?Caf=E9_cr=E8me?= ok")).toBe("Café crème ok");
    // "é" (C3 A9) split across two words, whitespace between words dropped
    expect(decodeEncodedWords("=?utf-8?Q?Caf=C3?= =?utf-8?Q?=A9?=")).toBe("Café");
    expect(decodeEncodedWords("plain =?utf-8?B?w6k=?= text")).toBe("plain é text");
    expect(decodeEncodedWords("=?unknown-charset?Q?abc?=")).toBe("abc");
    expect(decodeEncodedWords("no words here")).toBe("no words here");
  });

  it("parses content-type parameters", () => {
    expect(parseParams('text/HTML; charset="ISO-8859-1"; format=flowed')).toEqual({
      value: "text/html",
      params: { charset: "ISO-8859-1", format: "flowed" },
    });
    expect(parseParams("attachment").value).toBe("attachment");
    expect(parseParams(null)).toEqual({ value: "", params: {} });
  });

  it("parses address lists (quoted names, comments, groups, encoded names)", () => {
    expect(
      parseAddressList(
        '"Doe, Jane" <Jane@Example.COM>, bob@x.org (Bob B), =?utf-8?Q?Ren=C3=A9?= <r@x.fr>',
      ),
    ).toEqual([
      { address: "jane@example.com", name: "Doe, Jane" },
      { address: "bob@x.org", name: "Bob B" },
      { address: "r@x.fr", name: "René" },
    ]);
    expect(parseAddressList("Team: a@x.com, b@x.com; c@y.com")).toEqual([
      { address: "a@x.com", name: null },
      { address: "b@x.com", name: null },
      { address: "c@y.com", name: null },
    ]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });

  it("drops entries without a usable address, including a bare encoded-word", () => {
    expect(parseAddressList("=?utf-8?Q?security=40paypal.com?=, nobody, a@, @b")).toEqual([]);
    expect(parseAddressList("Hans <hans>, ok@x.de")).toEqual([{ address: "ok@x.de", name: null }]);
  });

  it("parses dates and snippet entities", () => {
    expect(parseMailDate("Tue, 1 Jul 2003 10:52:37 +0200 (CEST)")?.toISOString()).toBe(
      "2003-07-01T08:52:37.000Z",
    );
    expect(parseMailDate("garbage")).toBeNull();
    expect(decodeSnippetEntities("It&#39;s &amp; &lt;b&gt; &#x1F600; &bogus;")).toBe(
      "It's & <b> 😀 &bogus;",
    );
  });
});

function msg(payload: GmailMessagePart, extra: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    historyId: "9007199254740993",
    internalDate: "1700000000123",
    payload,
    ...extra,
  };
}

describe("parsedFromGmailPayload", () => {
  const headers = [
    { name: "From", value: '"Shop" <News@Shop.Example>' },
    { name: "To", value: "me@example.com" },
    { name: "Subject", value: "=?UTF-8?Q?50=25_off_=E2=80=94_today?=" },
    { name: "Date", value: "Mon, 25 Sep 2026 10:00:00 +0000" },
    { name: "Message-ID", value: " <abc@shop.example> " },
    { name: "List-Unsubscribe", value: "<https://shop.example/u>" },
  ];

  it("parses address headers before decoding, so encoded separators stay in the display name", async () => {
    const payload: GmailMessagePart = {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "=?utf-8?Q?security=40paypal.com=2C?= <attacker@evil.com>" },
        {
          name: "Reply-To",
          value: "=?utf-8?Q?=3Csecurity=40paypal.com=3E?= <attacker@evil.com>",
        },
        { name: "To", value: "=?iso-8859-1?Q?M=FCller=2C_Hans?= <hans@x.de>, me@example.com" },
        { name: "Cc", value: '"=?utf-8?B?PGJvc3NAeC5kZT4=?=" <cc@x.de>' },
      ],
      body: { size: 2, data: b64("hi") },
    };
    const p = await parsedFromGmailPayload(msg(payload), noFetch);
    expect(p.from).toEqual({ address: "attacker@evil.com", name: "security@paypal.com," });
    expect(p.replyTo).toEqual([{ address: "attacker@evil.com", name: "<security@paypal.com>" }]);
    expect(p.to).toEqual([
      { address: "hans@x.de", name: "Müller, Hans" },
      { address: "me@example.com", name: null },
    ]);
    expect(p.cc).toEqual([{ address: "cc@x.de", name: "<boss@x.de>" }]);
    // The headers array still carries decoded values.
    expect(p.headers.find((h) => h.name === "from")?.value).toBe(
      "security@paypal.com, <attacker@evil.com>",
    );
  });

  it("builds a ParsedEmail from a multipart tree with charsets, alternatives and attachments", async () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      headers,
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              headers: [{ name: "Content-Type", value: "text/plain; charset=utf-8" }],
              body: { size: 5, data: b64("plain") },
            },
            {
              mimeType: "text/html",
              headers: [{ name: "Content-Type", value: "text/html; charset=ISO-8859-1" }],
              body: {
                size: 12,
                data: b64(
                  Buffer.from([0x3c, 0x70, 0x3e, 0x43, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]),
                ),
              },
            },
          ],
        },
        { mimeType: "text/x-amp-html", body: { size: 3, data: b64("amp") } },
        {
          mimeType: "text/calendar",
          filename: "invite.ics",
          body: { size: 40, attachmentId: "ics1" },
        },
        {
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: "inline" },
            { name: "Content-ID", value: "<Logo@X>" },
          ],
          body: { size: 1234, attachmentId: "img1" },
        },
        {
          mimeType: "application/pdf",
          filename: "receipt.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="receipt.pdf"' }],
          body: { size: 999, attachmentId: "pdf1" },
        },
      ],
    };
    const p = await parsedFromGmailPayload(msg(payload), noFetch);
    expect(p.subject).toBe("50% off — today");
    expect(p.from).toEqual({ address: "news@shop.example", name: "Shop" });
    expect(p.to).toEqual([{ address: "me@example.com", name: null }]);
    expect(p.messageId).toBe("<abc@shop.example>");
    expect(p.date?.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    expect(p.html).toBe("<p>Café</p>");
    expect(p.htmlBytes).toBe(Buffer.byteLength("<p>Café</p>"));
    expect(p.text).toBe("plain");
    expect(p.hasAmp).toBe(true);
    expect(p.hasCalendar).toBe(true);
    expect(p.inline).toEqual([]);
    expect(p.attachments).toEqual([
      {
        filename: "invite.ics",
        mimeType: "text/calendar",
        size: 40,
        disposition: null,
        contentId: null,
      },
      {
        filename: "logo.png",
        mimeType: "image/png",
        size: 1234,
        disposition: "inline",
        contentId: "logo@x",
      },
      {
        filename: "receipt.pdf",
        mimeType: "application/pdf",
        size: 999,
        disposition: "attachment",
        contentId: null,
      },
    ]);
    expect(p.headers.find((h) => h.name === "list-unsubscribe")?.value).toBe(
      "<https://shop.example/u>",
    );
    expect(p.headers.every((h) => h.name === h.name.toLowerCase())).toBe(true);
  });

  it("fetches a body delivered as attachmentId through the callback with a byte cap", async () => {
    const calls: Array<{ id: string; maxBytes: number }> = [];
    const fetchAttachment: FetchAttachment = async (id, { maxBytes }) => {
      calls.push({ id, maxBytes });
      return Buffer.from("<html>big</html>");
    };
    const payload: GmailMessagePart = {
      mimeType: "text/html",
      headers: [...headers, { name: "Content-Type", value: "text/html; charset=utf-8" }],
      body: { size: 16, attachmentId: "big1" },
    };
    const p = await parsedFromGmailPayload(msg(payload), fetchAttachment, { maxBodyBytes: 1000 });
    expect(p.html).toBe("<html>big</html>");
    expect(calls).toEqual([{ id: "big1", maxBytes: 1000 }]);

    const huge: GmailMessagePart = {
      mimeType: "text/html",
      body: { size: 5_000_000, attachmentId: "big2" },
    };
    await expect(
      parsedFromGmailPayload(msg(huge), fetchAttachment, { maxBodyBytes: 1000 }),
    ).rejects.toMatchObject({
      kind: "too_large",
    });
    const inlineTooBig: GmailMessagePart = {
      mimeType: "text/plain",
      body: { data: b64("x".repeat(2000)) },
    };
    await expect(
      parsedFromGmailPayload(msg(inlineTooBig), noFetch, { maxBodyBytes: 1000 }),
    ).rejects.toMatchObject({
      kind: "too_large",
    });
  });

  it("concatenates split inline html parts outside an alternative", async () => {
    const payload: GmailMessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>a</p>") } },
        { mimeType: "image/jpeg", filename: "x.jpg", body: { size: 1, attachmentId: "i" } },
        { mimeType: "text/html", body: { data: b64("<p>b</p>") } },
      ],
    };
    const p = await parsedFromGmailPayload(msg(payload), noFetch);
    expect(p.html).toBe("<p>a</p>\n<p>b</p>");
    expect(p.text).toBeNull();
  });

  it("rejects malformed or hostile payloads", async () => {
    await expect(parsedFromGmailPayload({ id: "x" }, noFetch)).rejects.toMatchObject({
      kind: "bad_response",
    });
    await expect(
      parsedFromGmailPayload(msg({ mimeType: "text/plain", body: { data: "%%%" } }), noFetch),
    ).rejects.toMatchObject({
      kind: "bad_response",
    });
    let deep: GmailMessagePart = { mimeType: "text/plain", body: { data: b64("x") } };
    for (let i = 0; i < 100; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    await expect(parsedFromGmailPayload(msg(deep), noFetch)).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("plain-text mail has html null and htmlBytes 0", async () => {
    const p = await parsedFromGmailPayload(
      msg({ mimeType: "text/plain", headers, body: { data: b64("hi") } }),
      noFetch,
    );
    expect(p.html).toBeNull();
    expect(p.htmlBytes).toBe(0);
    expect(p.text).toBe("hi");
  });
});

describe("metaFromGmailMessage", () => {
  it("maps metadata with uint64 historyId as a string and decoded snippet", () => {
    expect(
      metaFromGmailMessage({
        id: "m1",
        threadId: "t1",
        labelIds: ["INBOX"],
        snippet: "Don&#39;t miss",
        historyId: "18446744073709551615",
        internalDate: "1700000000123",
        sizeEstimate: 42,
      }),
    ).toEqual({
      id: "m1",
      threadId: "t1",
      labelIds: ["INBOX"],
      snippet: "Don't miss",
      historyId: "18446744073709551615",
      internalDate: new Date(1700000000123),
      sizeEstimate: 42,
    });
    expect(() => metaFromGmailMessage({ id: "m1" })).toThrow(/bad_response/);
  });
});
