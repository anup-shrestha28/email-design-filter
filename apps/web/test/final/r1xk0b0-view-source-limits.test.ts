/**
 * The viewer's links and size limits line up with what serves them:
 * - inline (cid:) images have a total cap and an over-large view falls back to fit the 4.5 MB
 *   Vercel/edf-view body limit, instead of an email that can never be opened (R1-00);
 * - a mailto: link is disabled rather than sent to /out, which opens web links only (R1-01);
 * - /out accepts every link the viewer signs (8 KB), not only those under 4 KB (R1-02).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { signOutLink, signViewToken } from "@edf/crypto";
import type { SessionUser } from "@/server/session";
import { HAS_DB } from "../support/env";
import { appPool, createMailbox, createUser, seedEmail } from "../support/db";

const fixture = vi.hoisted(() => ({ raw: new Uint8Array() as Uint8Array }));
vi.mock("@/server/fixtures", () => ({ isFixtureAccount: () => true, readFixtureRaw: async () => fixture.raw }));

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/.{76}/g, "$&\r\n");

function htmlEmail(html: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "From: Northwind <hello@northwind.example>",
      "To: someone@gmail.example",
      "Subject: Autumn sale",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      b64(html),
      "",
    ].join("\r\n"),
  );
}

/** multipart/alternative (text + multipart/related html with inline PNG parts). */
function mimeEmail(opts: { html: string; text?: string; inline?: Array<{ cid: string; bytes: Buffer }> }): Uint8Array {
  const lines = [
    "From: Northwind <hello@northwind.example>",
    "To: someone@gmail.example",
    "Subject: Our photos",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(opts.text ?? "Plain version"),
    "--alt",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(opts.html),
  ];
  for (const p of opts.inline ?? []) {
    lines.push(
      "--rel",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${p.cid}>`,
      "Content-Disposition: inline",
      "",
      b64(p.bytes),
    );
  }
  lines.push("--rel--", "--alt--", "");
  return new TextEncoder().encode(lines.join("\r\n"));
}

/** A PNG-signed blob of `size` bytes (the sanitizer checks the magic bytes, not the pixels). */
function png(size: number, fill: number): Buffer {
  const b = Buffer.alloc(size, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  return b;
}

const user = (userId: string): SessionUser => ({
  userId,
  email: `${userId}@example.com`,
  name: "U",
  image: null,
  sessionId: "s",
  sessionCreatedAt: new Date(),
  role: "friend",
});

/** Each /out link in the view, decoded as the browser would send it. */
function outLinks(html: string): Array<{ u: string; t: string }> {
  return [...html.matchAll(/href="([^"]*\/out\?[^"]*)"/g)].map((m) => {
    const q = new URL(m[1]!.replaceAll("&amp;", "&")).searchParams;
    return { u: q.get("u") ?? "", t: q.get("t") ?? "" };
  });
}

// 5,000 chars, under the signer's 8 KB cap and over /out's former 4 KB one.
const LONG_TRACKING = `https://click.shop.example/ls/click?upn=${"Ab3dE9fG".repeat(620)}`;

describe("checkOutRequest accepts every link the signer signs", () => {
  it("opens a 5,000-character tracking link", async () => {
    const { outKeys } = await import("@/server/keys");
    const { checkOutRequest } = await import("@/server/out");
    expect(LONG_TRACKING.length).toBeGreaterThan(4096);
    const t = signOutLink(outKeys(), { sessionId: "u:u_long", url: LONG_TRACKING, exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(checkOutRequest(user("u_long"), { u: LONG_TRACKING, t })).toMatchObject({ ok: true, url: LONG_TRACKING, host: "click.shop.example" });
    // Anything longer can't have been signed.
    expect(checkOutRequest(user("u_long"), { u: `https://x.example/?q=${"a".repeat(8200)}`, t })).toMatchObject({ ok: false });
  });
});

afterAll(async () => {
  if (!HAS_DB) return;
  const { getPool } = await import("@/server/db");
  await (await getPool()).end();
});

describe.skipIf(!HAS_DB)("buildViewSource: links and body size", () => {
  const pool = appPool();
  let userId = "";
  let emailId = "";

  beforeAll(async () => {
    userId = (await createUser(pool)).id;
    emailId = await seedEmail(pool, userId, await createMailbox(pool, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function view(raw: Uint8Array) {
    fixture.raw = raw;
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const token = signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode: "img" });
    const r = await buildViewSource(token, emailId);
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    return r;
  }

  /** The route's response body: `{html, height}` as JSON. */
  const bodyBytes = (html: string, height: number) => Buffer.byteLength(JSON.stringify({ html, height }));

  it("keeps a photo-heavy email with many inline images under the body limit", async () => {
    const { VIEW_SOURCE_MAX_BODY_BYTES } = await import("@/server/view-source");
    // 10 inline photos just under the 256 KB per-image cap, each shown twice (thumbnail + full).
    const inline = Array.from({ length: 10 }, (_, i) => ({ cid: `photo${i}@x`, bytes: png(250 * 1024, i + 1) }));
    const imgs = inline.map((p) => `<img src="cid:${p.cid}" alt="thumb"><img src="cid:${p.cid}" alt="full">`).join("");
    const r = await view(mimeEmail({ html: `<html><body><h1>Our trip</h1>${imgs}</body></html>`, inline }));
    expect(VIEW_SOURCE_MAX_BODY_BYTES).toBeLessThan(4.5 * 1024 * 1024);
    expect(bodyBytes(r.html, r.height)).toBeLessThanOrEqual(VIEW_SOURCE_MAX_BODY_BYTES);
    const dataUris = [...r.html.matchAll(/src="data:image\/png;base64,[^"]*"/g)];
    expect(dataUris.length).toBeGreaterThan(0); // the first photos are still shown inline
    expect(dataUris.length).toBeLessThan(20);
    expect(r.html).toContain("Our trip");
    expect([...r.html.matchAll(/<img\b/g)]).toHaveLength(20); // the rest keep their alt text
  });

  it("falls back to the text version when the HTML alone is over the limit", async () => {
    const { VIEW_SOURCE_MAX_BODY_BYTES } = await import("@/server/view-source");
    const html = `<html><body><p>${"autumn sale ".repeat(400_000)}</p></body></html>`; // ~4.8 MB
    const r = await view(mimeEmail({ html, text: "Autumn sale: 30% off everything this week." }));
    expect(bodyBytes(r.html, r.height)).toBeLessThanOrEqual(VIEW_SOURCE_MAX_BODY_BYTES);
    expect(r.html).toContain("Autumn sale: 30% off everything this week.");
    expect(r.html).toMatch(/too large to show as designed/);
  });

  it("an HTML-only email over the limit falls back to the HTML's own text, with no image tokens", async () => {
    const { VIEW_SOURCE_MAX_BODY_BYTES } = await import("@/server/view-source");
    const html =
      `<html><head><style>.hero{color:red}</style><title>Sale</title></head><body>` +
      `<img src="https://cdn.shop.example/hero.png" width="600" height="300" alt="hero">` +
      `<h1>Fish &amp; Chips&nbsp;week</h1><script>track()</script><!-- hidden note -->` +
      `<p>${"autumn sale ".repeat(400_000)}</p><p>Last line &#8212; bye</p></body></html>`; // ~4.8 MB
    const r = await view(htmlEmail(html));
    expect(bodyBytes(r.html, r.height)).toBeLessThanOrEqual(VIEW_SOURCE_MAX_BODY_BYTES);
    expect(r.html).toMatch(/too large to show as designed/);
    expect(r.html).toContain("Fish &amp; Chips week"); // decoded once, escaped once for the <pre>
    expect(r.html).toContain("autumn sale autumn sale");
    expect(r.html).not.toMatch(/\.hero|track\(\)|hidden note|<h1/);
    expect(r.imageBytesMinted).toBe(0); // the discarded HTML's image token is never handed out
  });

  it("disables mailto: links instead of sending them to /out", async () => {
    const r = await view(
      htmlEmail(`<html><body><a href="mailto:help@shop.example?subject=Order">Email us</a><a href="https://shop.example/sale">Shop</a></body></html>`),
    );
    expect(r.html).not.toContain("mailto");
    expect(r.html).toContain("Email us");
    const links = outLinks(r.html);
    expect(links.map((l) => l.u)).toEqual(["https://shop.example/sale"]);
    expect(r.unsignableUrls).toBe(0);
  });

  it("every link the viewer shows opens at /out, including a 5,000-character one", async () => {
    const { checkOutRequest } = await import("@/server/out");
    const r = await view(htmlEmail(`<html><body><a href="${LONG_TRACKING}">Shop the sale</a><a href="https://shop.example/a">A</a></body></html>`));
    const links = outLinks(r.html);
    expect(links.map((l) => l.u)).toEqual([LONG_TRACKING, "https://shop.example/a"]);
    for (const l of links) expect(checkOutRequest(user(userId), l)).toMatchObject({ ok: true, url: l.u });
  });
});
