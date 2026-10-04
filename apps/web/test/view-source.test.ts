/**
 * buildViewSource with URLs the email controls that the signers refuse: that one image or link is
 * dropped and counted, and the view still succeeds (no 500 from a CryptoError). And the image
 * tokens it mints: never for a tracking pixel (by URL or by its element's size / hidden style),
 * one per distinct URL, and within the email's 40 MB budget in total (BUDGET).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicKey } from "node:crypto";
import { IMAGE_TOKEN_MAX_BYTES, signViewToken, verifyImageToken, type ViewMode } from "@edf/crypto";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, seedEmail } from "./support/db";

/** A view's total image allowance (view-source.ts EMAIL_BUDGET_BYTES; checked below). */
const BUDGET = 40 * 1024 * 1024;
/** What n alike images each get: an even share of the budget, at most the 5 MB per-image cap. */
const evenShare = (n: number) => Math.min(IMAGE_TOKEN_MAX_BYTES, Math.floor(BUDGET / n));

const fixture = vi.hoisted(() => ({ raw: new Uint8Array() as Uint8Array }));
vi.mock("@/server/fixtures", () => ({ isFixtureAccount: () => true, readFixtureRaw: async () => fixture.raw }));

const GOOD_IMG = "https://img.example.com/hero.png";
// Under the 4 KB policy cap, over the signer's 2 KB URL cap; human slugs pass the per-recipient check.
const LONG_IMG = `https://img.example.com${"/autumn-sale-hero".repeat(180)}.png`;
// Under 2 KB, but JSON escaping doubles each backslash and the token outgrows 4 KB.
const ESCAPED_IMG = `https://img.example.com/a.png?${"\\".repeat(1900)}`;
const GOOD_LINK = "https://shop.example/sale";
// Over the /out signer's 8 KB URL cap.
const LONG_LINK = `https://shop.example/p?q=${"a".repeat(8300)}`;

function rawEmail(html: string): Uint8Array {
  const body = Buffer.from(html).toString("base64").replace(/.{76}/g, "$&\r\n");
  return new TextEncoder().encode(
    [
      "From: Northwind <hello@northwind.example>",
      "To: someone@gmail.example",
      "Subject: Autumn sale",
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      body,
      "",
    ].join("\r\n"),
  );
}

afterAll(async () => {
  if (!HAS_DB) return;
  const { getPool } = await import("@/server/db");
  await (await getPool()).end();
});

describe.skipIf(!HAS_DB)("buildViewSource: unsignable URLs", () => {
  const pool = appPool();
  let userId = "";
  let emailId = "";

  beforeAll(async () => {
    fixture.raw = rawEmail(
      `<html><body><img src="${GOOD_IMG}" alt="hero"><img src="${LONG_IMG}" alt="long"><img src="${ESCAPED_IMG}" alt="escaped">` +
        `<a href="${GOOD_LINK}">Shop</a><a href="${LONG_LINK}">Long</a></body></html>`,
    );
    userId = (await createUser(pool)).id;
    emailId = await seedEmail(pool, userId, await createMailbox(pool, userId));
  });

  afterAll(async () => {
    await pool.end();
  });

  async function view(mode: ViewMode, id = emailId) {
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const token = signViewToken(viewKeys(), { userId, emailId: id, exp: Math.floor(Date.now() / 1000) + 240, mode });
    return buildViewSource(token, id);
  }

  it("shows the placeholder for the images the signers refuse, drops the link, and still returns the view", async () => {
    const r = await view("img");
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    const { env } = await import("@/env");
    const imgs = [...r.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs).toHaveLength(3);
    const prefix = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/img/`;
    expect(imgs.filter((t) => t.includes(prefix) && !t.includes(`${prefix}unavailable"`))).toHaveLength(1);
    // The two it can't sign show edf-view's "Picture unavailable" image, not a broken icon and alt text.
    expect(imgs.filter((t) => t.includes(`src="${prefix}unavailable"`))).toHaveLength(2);
    expect(r.html).toContain(`/out?u=${encodeURIComponent(GOOD_LINK)}`);
    expect(r.html).not.toContain("a".repeat(8300));
    expect(r.unsignableUrls).toBe(3);
    // Only the image that was actually signed counts toward the minted byte allowance.
    expect(r.imageBytesMinted).toBe(IMAGE_TOKEN_MAX_BYTES);
  });

  it("an over-long link doesn't stop the no-images view either", async () => {
    const r = await view("noimg");
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    expect(r.html).toContain(`/out?u=${encodeURIComponent(GOOD_LINK)}`);
    expect(r.unsignableUrls).toBe(1);
    expect(r.imageBytesMinted).toBe(0);
  });

  it("gives every email its own image budget id, in the form edf-view accepts", async () => {
    const { imageSigningKeys } = await import("@/server/keys");
    const signing = imageSigningKeys();
    if (!signing) throw new Error("IMG_SIGNING_KEYS is not configured for tests");
    const ring = { keys: new Map([...signing.keys].map(([kid, k]) => [kid, createPublicKey(k)])) };
    // Seeded back to back, so the uuidv7 ids (almost always) share their first 8 hex characters.
    const sibling = await seedEmail(pool, userId, await createMailbox(pool, userId));
    const budgetIds: string[] = [];
    for (const id of [emailId, sibling]) {
      const r = await view("img", id);
      if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
      const token = /\/img\/([A-Za-z0-9_.-]+)/.exec(r.html)?.[1] ?? "";
      const claims = verifyImageToken(ring, token, Math.floor(Date.now() / 1000));
      expect(claims?.e).toBe(id);
      expect(claims?.b).toBe(`${id}_${claims?.x.toString(36)}`);
      // edf-view's SHORT_ID_RE (apps/view/src/tokens.ts).
      expect(claims?.b).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      budgetIds.push(claims?.b ?? "");
    }
    expect(budgetIds[0]).not.toBe(budgetIds[1]);
  });
});

describe.skipIf(!HAS_DB)("buildViewSource: image tokens", () => {
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

  /** The view of `html`, with each minted token's claims in document order. */
  async function tokens(html: string, mode: ViewMode = "img") {
    fixture.raw = rawEmail(html);
    const { viewKeys, imageSigningKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const signing = imageSigningKeys();
    if (!signing) throw new Error("IMG_SIGNING_KEYS is not configured for tests");
    const ring = { keys: new Map([...signing.keys].map(([kid, k]) => [kid, createPublicKey(k)])) };
    const now = Math.floor(Date.now() / 1000);
    const r = await buildViewSource(signViewToken(viewKeys(), { userId, emailId, exp: now + 240, mode }), emailId);
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    // Every token occurrence (the static /img/unavailable placeholder is no token).
    const all = [...r.html.matchAll(/\/img\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]!).filter((t) => t !== "unavailable");
    const claims = [...new Set(all)].map((t) => {
      const c = verifyImageToken(ring, t, now);
      if (!c) throw new Error("minted token does not verify");
      return c;
    });
    return { r, all, claims };
  }

  it("never mints a token for a tracking pixel the size, max-size or hidden-style rules catch", async () => {
    // Unlisted hosts, no known pixel path, ids too short for the per-recipient check: only the
    // element's attributes make these pixels (DESIGN.md §6.3; crypto DECISIONS D-V4).
    const { claims } = await tokens(
      `<html><body>
       <img src="https://mail.shop.example/e/t?id=A1b2C3" width="1" height="1" alt="">
       <img src="https://cdn.shop.example/s.gif?c=991" style="display:none">
       <img src="https://cdn.shop.example/w.gif?c=992" style="max-width:1px">
       <div style="visibility:hidden;background:url(https://cdn.shop.example/bg.gif?c=993)">x</div>
       <img src="https://img.example.com/hero.png" width="600" height="300" alt="hero">
       </body></html>`,
    );
    expect(claims.map((c) => c.url)).toEqual(["https://img.example.com/hero.png"]);
  });

  it("mints one token per distinct URL, so a repeated icon doesn't use up the 60-token cap", async () => {
    const stars = Array.from({ length: 65 }, () => `<img src="https://img.example.com/star.png" width="16" height="16">`).join("");
    const products = Array.from({ length: 5 }, (_, i) => `<img src="https://img.example.com/product-${i}.png">`).join("");
    const { r, all, claims } = await tokens(`<html><body>${stars}${products}</body></html>`);
    expect(claims.map((c) => c.url)).toEqual([
      "https://img.example.com/star.png",
      ...Array.from({ length: 5 }, (_, i) => `https://img.example.com/product-${i}.png`),
    ]);
    expect(all).toHaveLength(70); // every occurrence is shown, with the one token of its URL
    expect(r.imageBytesMinted).toBe(claims.reduce((s, c) => s + c.mb, 0));
  });

  it("a gallery card ('card' mode) proxies the same images as the full view, with the same allowances; only its budget id differs", async () => {
    // Cards show the whole email (Pinterest-style masonry), so they load what the opened email
    // loads: a card's old top-of-email share (20 images, 6 MB) left big pictures as placeholders.
    const products = Array.from({ length: 25 }, (_, i) => `<img src="https://img.example.com/product-${i}.png" alt="Product ${i}">`).join("");
    const card = await tokens(`<html><body>${products}</body></html>`, "card");
    const full = await tokens(`<html><body>${products}</body></html>`, "img");
    expect(card.claims.map((c) => c.url)).toEqual(Array.from({ length: 25 }, (_, i) => `https://img.example.com/product-${i}.png`));
    expect(card.claims.map((c) => [c.url, c.mb])).toEqual(full.claims.map((c) => [c.url, c.mb]));
    expect(card.claims.reduce((s, c) => s + c.mb, 0)).toBeLessThanOrEqual(BUDGET);
    // Card images carry their own budget id (edf-view counts their served bytes apart, as a
    // diagnostic). The allowance is only an upper bound for edf-view: nothing here meters it; the
    // route meters the HTML, and edf-view's reports the bytes really served (FREE-TIER §8.1).
    for (const c of card.claims) expect(c.b.endsWith("_c")).toBe(true);
    for (const c of full.claims) expect(c.b.endsWith("_c")).toBe(false);
    expect(card.r.ok && card.r.imageBytesMinted).toBe(card.claims.reduce((s, c) => s + c.mb, 0));
    expect(card.r.ok && card.r.imageBytesMinted).toBeGreaterThan(0);
    expect(card.r).not.toHaveProperty("imageBytesMetered");
    expect(full.r).not.toHaveProperty("imageBytesMetered");
    // A card with one image gives it the per-image 5 MB (a one-picture mailer's hero).
    const one = await tokens(`<html><body><img src="https://img.example.com/hero.png" alt="Hero"></body></html>`, "card");
    expect(one.claims.map((c) => c.mb)).toEqual([5 * 1024 * 1024]);
    expect(one.r.ok && one.r.imageBytesMinted).toBe(5 * 1024 * 1024);
  });

  it("a view gives up to eight images the whole 5 MB (a big animated GIF beside others shows) and splits 40 MB past that", async () => {
    const { EMAIL_BUDGET_BYTES } = await import("@/server/view-source");
    expect(EMAIL_BUDGET_BYTES).toBe(BUDGET);
    const MB = 1024 * 1024;
    const imgs = (n: number) => Array.from({ length: n }, (_, i) => `<img src="https://img.example.com/hero-${i}.png" alt="Hero ${i}">`).join("");
    expect(IMAGE_TOKEN_MAX_BYTES).toBe(5 * MB);
    for (const [n, each] of [
      [1, 5 * MB],
      [3, 5 * MB],
      [4, 5 * MB],
      [8, 5 * MB],
      [9, evenShare(9)],
      [12, evenShare(12)],
    ] as const) {
      const { r, claims } = await tokens(`<html><body>${imgs(n)}</body></html>`);
      expect(claims.map((c) => c.mb), `${n} images`).toEqual(Array(n).fill(each));
      expect(r.imageBytesMinted).toBeLessThanOrEqual(BUDGET);
    }
    // A card's lone hero gets the same 5 MB (its 6 MB is shared by declared size, ≤ 5 MB each).
    const card = await tokens(`<html><body>${imgs(1)}</body></html>`, "card");
    expect(card.claims.map((c) => c.mb)).toEqual([5 * MB]);
  });

  it("a card shares the email's 40 MB by declared size, exactly as the opened email does: big pictures get several MB wherever they are", async () => {
    const MB = 1024 * 1024;
    const { fullViewImageAllowances } = await import("@/server/view-source");
    const logo = `<img src="https://img.example.com/logo.png" width="150" height="40" alt="Brand">`;
    const hero = `<img src="https://img.example.com/hero.gif" width="600" style="width:600px;height:auto" alt="Sale">`;
    const hero2 = `<img src="https://img.example.com/hero-2.gif" width="600" height="600" alt="More">`;
    const icons = Array.from({ length: 12 }, (_, i) => `<img src="https://img.example.com/icon-${i}.png" width="32" height="32" alt="">`).join("");
    const bg = `<table><tr><td style="background-image:url(https://img.example.com/bg.jpg)" width="600" height="200">Hi</td></tr></table>`;
    const html = `<html><body>${logo}${bg}${hero}${icons}${hero2}</body></html>`;
    const { r, claims } = await tokens(html, "card");
    expect(claims.map((c) => c.url.split("/").pop())).toEqual(["logo.png", "bg.jpg", "hero.gif", ...Array.from({ length: 12 }, (_, i) => `icon-${i}.png`), "hero-2.gif"]);
    expect(claims.map((c) => c.mb)).toEqual(
      fullViewImageAllowances([
        { width: "150", height: "40", style: null },
        { width: "600", height: "200", style: "background-image:url(https://img.example.com/bg.jpg)" },
        { width: "600", height: null, style: "width:600px;height:auto" },
        ...Array.from({ length: 12 }, () => ({ width: "32", height: "32", style: null })),
        { width: "600", height: "600", style: null },
      ]),
    );
    const byName = new Map(claims.map((c) => [c.url.split("/").pop(), c.mb]));
    // Both big pictures — the second one far down the email — get several MB (a card used to give
    // a picture that far down ≈ 0.3 MB: "Picture unavailable" for any real hero).
    expect(byName.get("hero.gif")).toBeGreaterThan(3 * MB);
    expect(byName.get("hero-2.gif")).toBeGreaterThan(3 * MB);
    for (let i = 0; i < 12; i++) expect(byName.get(`icon-${i}.png`)).toBeGreaterThanOrEqual(100 * 1024);
    const total = claims.reduce((s, c) => s + c.mb, 0);
    expect(total).toBeLessThanOrEqual(BUDGET);
    expect(r.imageBytesMinted).toBe(total);
    const full = await tokens(html, "img");
    expect(full.claims.map((c) => [c.url, c.mb])).toEqual(claims.map((c) => [c.url, c.mb]));
  });

  it("a big animated GIF among a dozen pictures gets its full 5 MB (Canva's 3.9 MB GIF was 'Picture unavailable' at 15 MB)", async () => {
    // The real email (2026-10-04): a logo, a 3.9 MB GIF, six 600 px PNGs of 20–270 KB and seven
    // small icons, all declared by width. At 15 MB the GIF got 2.9 MB; Gmail showed it.
    const logo = `<img src="https://img.example.com/logo.png" width="120" alt="Canva">`;
    const gif = `<img src="https://img.example.com/shortcuts.gif" width="600" alt="Shortcuts">`;
    const pngs = Array.from({ length: 6 }, (_, i) => `<img src="https://img.example.com/tile-${i}.png" width="600" alt="Tile ${i}">`).join("");
    const icons = Array.from({ length: 7 }, (_, i) => `<img src="https://img.example.com/icon-${i}.png" width="24" height="24" alt="">`).join("");
    for (const mode of ["card", "img"] as const) {
      const { claims } = await tokens(`<html><body>${logo}${gif}${pngs}${icons}</body></html>`, mode);
      const gifClaim = claims.find((c) => c.url.endsWith("shortcuts.gif"))!;
      expect(gifClaim.mb, mode).toBe(5 * 1024 * 1024);
      expect(gifClaim.mb).toBeGreaterThan(4_091_165);
      expect(claims.reduce((s, c) => s + c.mb, 0)).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("a full view's shares count only the images it proxies (not trackers, pixels or expired links), so its hero gets the full 5 MB, in its card too", async () => {
    const MB = 1024 * 1024;
    const { fullViewImageAllowances } = await import("@/server/view-source");
    const now = Math.floor(Date.now() / 1000);
    const li = (i: number) => `https://media.licdn.com/dms/image/v2/D56${i}/p/0/1?e=${now - 86_400}&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ`;
    const skipped =
      `<img src="https://us1.list-manage.com/track/open.php?u=1" width="600" height="300" alt="">` +
      `<img src="https://mail.shop.example/open.gif?c=7" width="1" height="1">` +
      Array.from({ length: 4 }, (_, i) => `<img src="${li(i)}" width="48" height="48" alt="">`).join("");
    const hero = `<img src="https://img.example.com/hero.gif" width="600" height="600" alt="Sale">`;
    const smalls = Array.from({ length: 8 }, (_, i) => `<img src="https://img.example.com/s-${i}.png" width="24" height="24" alt="">`).join("");
    const html = `<html><body><img src="https://img.example.com/logo.png" width="150" height="40" alt="Brand">${skipped}${hero}${smalls}</body></html>`;
    const card = await tokens(html, "card");
    const full = await tokens(html, "img");
    const hints = [{ width: "150", height: "40" }, { width: "600", height: "600" }, ...Array.from({ length: 8 }, () => ({ width: "24", height: "24" }))];
    expect(full.claims.map((c) => c.mb)).toEqual(fullViewImageAllowances(hints));
    expect(card.claims.map((c) => c.mb)).toEqual(full.claims.map((c) => c.mb));
    expect(full.claims[1]!.mb).toBe(5 * MB);
  });

  it("a full view whose first estimate is too high (images the sanitizer drops) still gives its images their exact shares", async () => {
    const { fullViewImageAllowances } = await import("@/server/view-source");
    // Counted by extractImageRefs, but inside a <template> the sanitizer removes: estimated 20, proxied 6.
    const dropped = Array.from({ length: 14 }, (_, i) => `<img src="https://img.example.com/t-${i}.png">`).join("");
    const shownImgs = Array.from({ length: 6 }, (_, i) => `<img src="https://img.example.com/s-${i}.png" alt="S${i}">`).join("");
    const { r, claims } = await tokens(`<html><body><template>${dropped}</template>${shownImgs}</body></html>`);
    expect(claims.map((c) => c.mb)).toEqual(fullViewImageAllowances(Array.from({ length: 6 }, () => ({}))));
    expect(r.imageBytesMinted).toBe(6 * evenShare(6)); // 5 MB each (the cap), not a 20-way share
  });

  it("a full view past its 60-image cap shows the placeholder for the rest; a card past the same 60 paints nothing", async () => {
    const { env } = await import("@/env");
    const placeholder = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/img/unavailable`;
    const images = Array.from({ length: 63 }, (_, i) => `<img src="https://img.example.com/p-${i}.png" alt="P${i}">`).join("");
    const full = await tokens(`<html><body>${images}</body></html>`);
    expect(full.claims).toHaveLength(60);
    const fullTags = [...full.r.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(fullTags.slice(60).every((t) => t.includes(`src="${placeholder}"`))).toBe(true);
    const card = await tokens(`<html><body>${images}</body></html>`, "card");
    expect(card.claims).toHaveLength(60);
    const cardTags = [...card.r.html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(cardTags.slice(0, 60).every((t) => /\/img\/[A-Za-z0-9_.-]+"/.test(t))).toBe(true);
    expect(cardTags.slice(60).every((t) => !/\ssrc=/.test(t))).toBe(true);
    expect(card.r.html).not.toContain(placeholder);
  });

  it("random emails: within budget, one token per URL, and a card gives every image what the opened email gives it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = `https://media.licdn.com/dms/image/v2/D4D16AQ/p/0/1?e=${now - 86_400}&v=beta&t=abcdefg`;
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
    for (let k = 0; k < 40; k++) {
      const n = 1 + Math.floor(rnd() * 40);
      const urls = Array.from({ length: Math.max(1, Math.floor(n * 0.7)) }, (_, i) => `https://img${k}.example.com/a/${i}.png`);
      const parts: string[] = [];
      const css: string[] = [];
      for (let i = 0; i < n; i++) {
        const u = pick(urls);
        const w = pick(["", "1", "24", "96", "300", "600", "100%"]);
        const h = pick(["", "1", "24", "96", "300", "600"]);
        const attrs = `${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""}`;
        const kind = rnd();
        if (kind < 0.55) parts.push(`<img src="${u}"${attrs} alt="x">`);
        else if (kind < 0.7) parts.push(`<img src="${u}"${attrs} style="display:none" alt="hidden">`);
        else if (kind < 0.8) parts.push(`<table><tr><td${attrs} background="${u}">bg</td></tr></table>`);
        else if (kind < 0.9) parts.push(`<div${attrs} style="background-image:url(${u});width:${w || 200}px">d</div>`);
        else css.push(`.c${i}{background:url(${u})}`);
        if (rnd() < 0.05) parts.push(`<img src="${expired}&k=${i}" width="48" height="48">`);
      }
      const html = `<html><head><style>${css.join("")}</style></head><body>${parts.join("")}</body></html>`;
      const card = await tokens(html, "card");
      const full = await tokens(html, "img");
      for (const [v, budget, cap] of [[card, BUDGET, 60], [full, BUDGET, 60]] as const) {
        const total = v.claims.reduce((s, c) => s + c.mb, 0);
        expect(total, html).toBeLessThanOrEqual(budget);
        expect(v.claims.length).toBeLessThanOrEqual(cap);
        expect(new Set(v.claims.map((c) => c.url)).size, html).toBe(v.claims.length);
        expect(v.r.imageBytesMinted, html).toBe(total);
        for (const c of v.claims) expect(c.mb).toBeGreaterThan(0);
      }
      // The card proxies exactly the full view's images, in the same order, with the same allowances.
      expect(card.claims.map((c) => [c.url, c.mb]), html).toEqual(full.claims.map((c) => [c.url, c.mb]));
    }
  });

  it("keeps the signed allowances within the 40 MB email budget when the image scan saw fewer images", async () => {
    // extractImageRefs reads only the first 2 MB of HTML, so it counts none of these 60 images and
    // would give each the full 5 MB (300 MB in total).
    const images = Array.from({ length: 60 }, (_, i) => `<img src="https://img${i}.example.com/p.png">`).join("");
    const { r, claims } = await tokens(`<html><body><p>${"autumn sale ".repeat(180_000)}</p>${images}</body></html>`);
    const total = claims.reduce((s, c) => s + c.mb, 0);
    // The render counts what it proxies and re-mints from that: every image gets its share of the
    // exact list (fullViewImageAllowances: the card's 20 their card shares, the rest ≈ 223 KB),
    // none is left without a src once the first 5 MB allowances used up the budget.
    const { fullViewImageAllowances } = await import("@/server/view-source");
    expect(claims).toHaveLength(60);
    expect(claims.map((c) => c.mb)).toEqual(fullViewImageAllowances(Array.from({ length: 60 }, () => ({}))));
    for (const c of claims) expect(c.mb).toBeGreaterThan(200 * 1024);
    expect(total).toBeLessThanOrEqual(BUDGET);
    expect(r.imageBytesMinted).toBe(total);
    for (const c of claims) expect(c.mb).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("buildViewSource: hidden copies and a card's missing images", () => {
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

  async function view(html: string, mode: ViewMode) {
    fixture.raw = rawEmail(html);
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const r = await buildViewSource(signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode }), emailId);
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    return r;
  }
  const imgTags = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  const srcOf = (tag: string) => /\ssrc="([^"]*)"/.exec(tag)?.[1] ?? null;

  // A logo shown by default, a hidden dark-mode copy of it that the email's CSS reveals, and a
  // hidden light copy with its own URL (the Microsoft-style swap from the 2026-09-30 audit).
  const LOGO = "https://img.example.com/brand/logo-dark.png";
  const LIGHT = "https://img.example.com/brand/logo-light.png";
  const shown = `<img class="darkLogo" src="${LOGO}" alt="Brand" width="113" height="24" style="display:block">`;
  const darkCopy = `<div style="display:none"><img class="darkLogo" src="${LOGO}" alt="Brand" width="113" height="24" style="display: none;"></div>`;
  const lightCopy = `<div style="display:none"><img class="lightLogo" src="${LIGHT}" alt="Brand" width="113" height="24" style="display: none;"></div>`;
  const css = "<style>@media screen{.darkLogo{display:block!important}}</style>";

  it.each([
    ["after", `${shown}${darkCopy}${lightCopy}`],
    ["before", `${darkCopy}${lightCopy}${shown}`],
  ])("a hidden copy of a URL another occurrence loads shares its token (%s it); a hidden-only URL stays unloaded", async (_order, body) => {
    for (const mode of ["img", "card"] as const) {
      const r = await view(`<html><head>${css}</head><body>${body}</body></html>`, mode);
      const tags = imgTags(r.html);
      const logos = tags.filter((t) => t.includes("darkLogo"));
      expect(logos).toHaveLength(2);
      expect(srcOf(logos[0]!)).toMatch(/\/img\/[A-Za-z0-9_.-]+$/);
      expect(srcOf(logos[1]!)).toBe(srcOf(logos[0]!));
      // The hidden-only light copy is a pixel by the hidden-style rule: no src, alt kept.
      const light = tags.find((t) => t.includes("lightLogo"))!;
      expect(srcOf(light)).toBeNull();
      expect(light).toContain('alt="Brand"');
      // One token was minted (one URL), none for the hidden-only one.
      expect(new Set([...r.html.matchAll(/\/img\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1])).size).toBe(1);
    }
  });

  it.each([7, 10, 19])(
    "a hidden copy first doesn't make a card under-count its images: the logo and %i more all get a full share",
    async (count) => {
      // extractImageRefs keeps a URL's first occurrence (the hidden copy, a pixel), so the first
      // estimate is one image short: sized for that, the budget used to run out before the cap
      // (the last image got no src, or an allowance of a few bytes: a grey placeholder).
      const { imageSigningKeys } = await import("@/server/keys");
      const { fullViewImageAllowances } = await import("@/server/view-source");
      const signing = imageSigningKeys()!;
      const ring = { keys: new Map([...signing.keys].map(([kid, k]) => [kid, createPublicKey(k)])) };
      const products = Array.from({ length: count }, (_, i) => `<img src="https://img.example.com/p-${i}.png" alt="P${i}">`).join("");
      const r = await view(`<html><head>${css}</head><body>${darkCopy}${shown}${products}</body></html>`, "card");
      const tags = imgTags(r.html);
      const sources = tags.map(srcOf);
      expect(sources.every((s) => s !== null && /\/img\/[A-Za-z0-9_.-]+$/.test(s))).toBe(true);
      expect(sources[0]).toBe(sources[1]); // the hidden copy shares the shown logo's token
      const now = Math.floor(Date.now() / 1000);
      const claims = [...new Set(sources)].map((s) => verifyImageToken(ring, s!.split("/img/")[1]!, now)!);
      expect(claims.map((c) => c.url)).toEqual([LOGO, ...Array.from({ length: count }, (_, i) => `https://img.example.com/p-${i}.png`)]);
      // Shares for exactly the logo (as shown) and the products, by their declared sizes.
      expect(claims.map((c) => c.mb)).toEqual(
        fullViewImageAllowances([
          { width: "113", height: "24", style: "display:block" },
          ...Array.from({ length: count }, () => ({ width: null, height: null, style: null })),
        ]),
      );
      expect(claims.reduce((s, c) => s + c.mb, 0)).toBeLessThanOrEqual(BUDGET);
      expect(r.imageBytesMinted).toBe(claims.reduce((s, c) => s + c.mb, 0));
    },
  );

  it("a card whose first estimate is too high (images the sanitizer drops) still gives its images their exact shares", async () => {
    // Counted by extractImageRefs, but inside a <template> the sanitizer removes: estimated 20, proxied 6.
    const dropped = Array.from({ length: 14 }, (_, i) => `<img src="https://img.example.com/t-${i}.png">`).join("");
    const shownImgs = Array.from({ length: 6 }, (_, i) => `<img src="https://img.example.com/s-${i}.png" alt="S${i}">`).join("");
    const r = await view(`<html><body><template>${dropped}</template>${shownImgs}</body></html>`, "card");
    const { fullViewImageAllowances } = await import("@/server/view-source");
    const minted = new Set([...r.html.matchAll(/\/img\/([A-Za-z0-9_.-]+)/g)].map((m) => m[1]));
    expect(minted.size).toBe(6);
    // Shares of 6 images (2.5 MB each), not a 20-way share.
    const six = fullViewImageAllowances(Array.from({ length: 6 }, () => ({})));
    expect(r.imageBytesMinted).toBe(six.reduce((s, a) => s + a, 0));
    expect(r.imageBytesMinted).toBe(6 * evenShare(6));
  });

  it("an expired signed CDN URL (LinkedIn's `e`) is not proxied: it shows the static placeholder, no token, no card slot", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { env } = await import("@/env");
    const placeholder = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/img/unavailable`;
    const li = (e: number, i: number) =>
      `https://media.licdn.com/dms/image/v2/D56${i}/p/0/1?e=${e}&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ`;
    const body = `<img src="${li(now - 86_400, 1)}" alt="Old post"><img src="${li(now + 86_400, 2)}" alt="New post">`;
    for (const mode of ["img", "card"] as const) {
      const r = await view(`<html><body>${body}</body></html>`, mode);
      const tags = imgTags(r.html);
      expect(srcOf(tags[0]!)).toBe(placeholder);
      expect(tags[0]).toContain('alt="Old post"');
      expect(srcOf(tags[1]!)).toMatch(/\/img\/[A-Za-z0-9_-]+\./);
      // One token, for the live URL only; the expired one costs no allowance.
      expect(new Set([...r.html.matchAll(/\/img\/([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+)/g)].map((m) => m[1])).size).toBe(1);
      expect(r.imageBytesMinted).toBe(5 * 1024 * 1024); // the live one alone: 5 MB in either mode
    }
    // The images-off view shows neither.
    const off = await view(`<html><body>${body}</body></html>`, "noimg");
    expect(imgTags(off.html).every((t) => srcOf(t) === null)).toBe(true);
  });

  it("a CSS background that can't load (an expired link, past a full view's cap) is dropped, never painted with the placeholder", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { env } = await import("@/env");
    const placeholder = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/img/unavailable`;
    const expired = `https://media.licdn.com/dms/image/v2/D563/p/0/1?e=${now - 86_400}&v=beta&t=9w4DX0pH0Pqra2nqbEU6IXXhbzgkznNaIZEoT-QTclQ`;
    // A LinkedIn-style video cover (a cell with a dark colour, white text and a cover background),
    // the same URL as a `background` attribute, then as an <img>: per occurrence, only the <img>
    // gets the placeholder; the backgrounds are dropped so the cells keep their own colour.
    const html =
      `<html><body><table><tr><td class="cover" style="height:252px;background-color:#111111;background-position:center;background-size:cover;background-image:url(${expired})" width="462" height="252"><font color="#ffffff">Watch</font></td>` +
      `<td class="attr" background="${expired}" bgcolor="#111111">Read</td></tr></table><img src="${expired}" alt="Post"></body></html>`;
    for (const mode of ["img", "card"] as const) {
      const r = await view(html, mode);
      expect(r.html.split(placeholder)).toHaveLength(2); // once: the <img>
      expect(srcOf(imgTags(r.html)[0]!)).toBe(placeholder);
      const cover = /<td class="cover"[^>]*>/.exec(r.html)![0];
      expect(cover).toContain("background-color:#111111");
      expect(cover).not.toContain("/img/");
      const attr = /<td class="attr"[^>]*>/.exec(r.html)![0];
      expect(attr).not.toContain("background=");
      expect(attr).toContain('bgcolor="#111111"');
    }
    // Past a full view's 60 images: an <img> gets the placeholder, a background is dropped.
    const sixty = Array.from({ length: 60 }, (_, i) => `<img src="https://img.example.com/p-${i}.png" alt="P${i}">`).join("");
    const late = `<div class="late" style="background-color:#222222;background-image:url(https://img.example.com/bg-60.png)">Late</div><img src="https://img.example.com/p-61.png" alt="P61">`;
    const full = await view(`<html><body>${sixty}${late}</body></html>`, "img");
    expect(full.html.split(placeholder)).toHaveLength(2);
    expect(srcOf(imgTags(full.html)[60]!)).toBe(placeholder);
    const div = /<div class="late"[^>]*>/.exec(full.html)![0];
    expect(div).toContain("#222222");
    expect(div).not.toContain("/img/");
  });

  it("an image blocked for privacy keeps no src (invisible in a card), never the placeholder", async () => {
    const r = await view(
      `<html><body><img src="https://mail.shop.example/open.gif?c=7" width="1" height="1"><img src="https://us1.list-manage.com/track/open.php?u=1" width="600" height="300" alt="Tracked"></body></html>`,
      "card",
    );
    for (const t of imgTags(r.html)) expect(srcOf(t)).toBeNull();
    expect(r.html).not.toContain("/img/");
  });

  it("a pixel-sized occurrence never unlocks a URL nothing else loads", async () => {
    const r = await view(`<html><body><img src="https://mail.shop.example/p.gif?c=7" width="1" height="1"><img src="https://mail.shop.example/p.gif?c=7" style="display:none"></body></html>`, "img");
    expect(r.html).not.toContain("/img/");
  });

  it("a card paints no alt text for the images it doesn't load; the opened design still does", async () => {
    const { CARD_MISSING_IMAGE_CSS } = await import("@/server/view-source");
    // Past the 60-image cap, two images get no src.
    const products = Array.from({ length: 62 }, (_, i) => `<img src="https://img.example.com/p-${i}.png" alt="Product ${i} in a long sentence">`).join("");
    const card = await view(`<html><head><style>img{color:#333}</style></head><body>${products}</body></html>`, "card");
    expect(card.html.endsWith(CARD_MISSING_IMAGE_CSS)).toBe(true);
    const missing = imgTags(card.html).filter((t) => srcOf(t) === null);
    expect(missing).toHaveLength(2);
    // The alt text stays in the document (screen readers), only its paint is hidden.
    expect(missing[1]).toContain('alt="Product 61 in a long sentence"');
    // Paints nothing (no broken-image icon, alt text or link underline) but keeps the box, and
    // stays in the accessibility tree (opacity, not visibility or display).
    expect(CARD_MISSING_IMAGE_CSS).toMatch(/^<style>html body img:not\(\[src\]\)\{opacity:0!important;color:transparent!important;[^<]*\}<\/style>$/);
    expect(CARD_MISSING_IMAGE_CSS).not.toMatch(/visibility|display/);
    for (const mode of ["img", "noimg"] as const) {
      const full = await view(`<html><body>${products}</body></html>`, mode);
      expect(full.html).not.toContain("img:not([src])");
    }
  });
});

describe.skipIf(!HAS_DB)("buildViewSource: embedded (cid:) images", () => {
  const pool = appPool();
  afterAll(async () => {
    await pool.end();
  });

  function related(html: string): Uint8Array {
    // A 1×1 PNG, embedded as a multipart/related part (Content-ID <logo@shop>).
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    return new TextEncoder().encode(
      [
        "From: Shop <orders@shop.example>",
        "To: someone@gmail.example",
        "Subject: Your order has shipped",
        "MIME-Version: 1.0",
        'Content-Type: multipart/related; boundary="rel"',
        "",
        "--rel",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
        "--rel",
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        "Content-ID: <logo@shop>",
        "",
        png,
        "--rel--",
        "",
      ].join("\r\n"),
    );
  }

  it("a transactional email's embedded logo shows (no remote fetch, so no tracking), but not with images off", async () => {
    fixture.raw = related(`<html><body><img src="cid:logo@shop" alt="Shop"><img src="https://img.example.com/remote.png" alt="remote"></body></html>`);
    const userId = (await createUser(pool)).id;
    const emailId = await seedEmail(pool, userId, await createMailbox(pool, userId), { primaryType: "transactional" });
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const at = (mode: ViewMode) =>
      buildViewSource(signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode }), emailId);
    const on = await at("img");
    if (!on.ok) throw new Error(`view failed: ${on.status}`);
    expect(on.html).toContain('src="data:image/png;base64,');
    expect(on.html).not.toContain("/img/"); // remote images stay off in transactional mail
    const off = await at("noimg");
    if (!off.ok) throw new Error(`view failed: ${off.status}`);
    expect(off.html).not.toContain("data:image/png");
  });
});

describe.skipIf(!HAS_DB)("buildViewSource: Gmail's default font", () => {
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

  it("every view starts its head with the zero-specificity Arial default, before the email's own CSS", async () => {
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource, VIEWER_DEFAULT_FONT_CSS } = await import("@/server/view-source");
    expect(VIEWER_DEFAULT_FONT_CSS).toBe("<style>:where(html){font-family:Arial,Helvetica,sans-serif}</style>");
    for (const html of [
      `<html lang="en" dir="ltr"><head><style>p{font-family:Georgia}</style></head><body><p>Autumn sale</p></body></html>`,
      "<p>A fragment with no html, head or font</p>",
    ]) {
      fixture.raw = rawEmail(html);
      for (const mode of ["img", "noimg", "card"] as const) {
        const r = await buildViewSource(signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode }), emailId);
        if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
        expect(r.html, mode).toMatch(/^<!DOCTYPE html>\n<html[^>]*><head><style>:where\(html\)\{font-family:Arial,Helvetica,sans-serif\}<\/style>/);
        expect(r.html.split(VIEWER_DEFAULT_FONT_CSS)).toHaveLength(2); // once
        if (html.includes("Georgia")) expect(r.html.indexOf("Georgia")).toBeGreaterThan(r.html.indexOf(VIEWER_DEFAULT_FONT_CSS));
      }
    }
  });
});
