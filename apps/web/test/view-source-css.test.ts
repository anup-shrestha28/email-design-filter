/**
 * buildViewSource declares the real longest image URL (view origin + "/img/" + the longest token,
 * as written in CSS) to the sanitizer, so a CSS url() near the end of a large stylesheet is
 * reserved exactly that much room, not the sanitizer's 8 KB default, and is kept when it fits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IMAGE_TOKEN_MAX_LENGTH, signViewToken, type ViewMode } from "@edf/crypto";
import { CSS_MAX_BYTES } from "@edf/sanitize";
import type { Env } from "@/env";
import { HAS_DB } from "./support/env";
import { appPool, createMailbox, createUser, seedEmail } from "./support/db";

const fixture = vi.hoisted(() => ({ raw: new Uint8Array() as Uint8Array, viewOrigin: null as string | null }));
vi.mock("@/server/fixtures", () => ({ isFixtureAccount: () => true, readFixtureRaw: async () => fixture.raw }));
vi.mock("@/env", async (importOriginal) => {
  const m = await importOriginal<{ env: () => Env }>();
  return { ...m, env: () => (fixture.viewOrigin === null ? m.env() : { ...m.env(), VIEW_ORIGIN: fixture.viewOrigin }) };
});

const BG_IMG = "https://img.example.com/autumn-background.png";
const HERO_RULE = `.hero{background:url(${BG_IMG})}`;
const HERO_BLANK = ".hero{background:url()}";

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

/** Rules without urls, written as the sanitizer writes them, exactly `bytes` long. */
function filler(bytes: number): string {
  let css = "";
  for (let i = 0; css.length + 40 <= bytes; i++) css += `.f${i}{margin:0}`;
  const pad = bytes - css.length - ".pad{margin:}".length;
  return `${css}.pad{margin:${"0".repeat(pad)}}`;
}

/** A stylesheet whose last rule has a background url, with `room` bytes left for its value. */
function emailWithRoom(room: number): Uint8Array {
  const css = filler(CSS_MAX_BYTES - room - HERO_BLANK.length) + HERO_RULE;
  return rawEmail(`<html><head><style>${css}</style></head><body><p class="hero">Sale</p></body></html>`);
}

describe.skipIf(!HAS_DB)("buildViewSource: CSS image url reserve", () => {
  const pool = appPool();
  let userId = "";
  let emailId = "";
  let prefix = "";

  beforeAll(async () => {
    userId = (await createUser(pool)).id;
    emailId = await seedEmail(pool, userId, await createMailbox(pool, userId));
    const { env } = await import("@/env");
    prefix = `${env().VIEW_ORIGIN.replace(/\/$/, "")}/img/`;
  });

  afterAll(async () => {
    await pool.end();
    const { getPool } = await import("@/server/db");
    await (await getPool()).end();
  });

  async function view(mode: ViewMode) {
    const { viewKeys } = await import("@/server/keys");
    const { buildViewSource } = await import("@/server/view-source");
    const token = signViewToken(viewKeys(), { userId, emailId, exp: Math.floor(Date.now() / 1000) + 240, mode });
    const r = await buildViewSource(token, emailId);
    if (!r.ok) throw new Error(`view failed: ${r.status} ${r.error}`);
    return r;
  }

  const heroKept = (p: string) =>
    new RegExp(`\\.hero\\{background:url\\(${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[A-Za-z0-9_.-]+\\)\\}`);

  it("keeps a background url near the end of a large stylesheet when exactly the real bound fits", async () => {
    // Less than the sanitizer's 8 KB default: the prefix plus the longest (4 KB) token.
    const room = prefix.length + IMAGE_TOKEN_MAX_LENGTH;
    expect(room).toBeLessThan(8192);
    fixture.raw = emailWithRoom(room);
    const r = await view("img");
    expect(r.html).toContain(".pad{margin:");
    expect(r.html).toMatch(heroKept(prefix));
    expect(r.imageBytesMinted).toBeGreaterThan(0);
  });

  it("drops it, without minting, when there is one byte less than the real bound", async () => {
    fixture.raw = emailWithRoom(prefix.length + IMAGE_TOKEN_MAX_LENGTH - 1);
    const r = await view("img");
    expect(r.html).toContain(".pad{margin:");
    expect(r.html).not.toContain(`${prefix}`);
    expect(r.html).not.toContain("background:url(");
    expect(r.imageBytesMinted).toBe(0);
  });

  describe("with a view origin whose path CSS escapes", () => {
    // "https://view.example/a(b)/img/" is 30 characters; in a CSS url() it is written
    // "https://view.example/a\(b\)/img/", 32 bytes, so the reserve is 32 + the longest token.
    const origin = "https://view.example/a(b)";
    const cssPrefixBytes = 32;
    beforeAll(() => {
      fixture.viewOrigin = origin;
    });
    afterAll(() => {
      fixture.viewOrigin = null;
    });

    it("reserves the escaped length, so the url is kept when exactly that fits", async () => {
      fixture.raw = emailWithRoom(cssPrefixBytes + IMAGE_TOKEN_MAX_LENGTH);
      const r = await view("img");
      expect(r.html).toContain(".hero{background:url(https://view.example/a\\(b\\)/img/");
      expect(r.imageBytesMinted).toBeGreaterThan(0);
    });

    it("drops it, without minting, when there is one byte less", async () => {
      fixture.raw = emailWithRoom(cssPrefixBytes + IMAGE_TOKEN_MAX_LENGTH - 1);
      const r = await view("img");
      expect(r.html).not.toContain("background:url(");
      expect(r.imageBytesMinted).toBe(0);
    });
  });
});
