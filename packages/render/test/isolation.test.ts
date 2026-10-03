/**
 * Renderer isolation (DESIGN.md §6.2): JavaScript is off before load, every request other than
 * `data:` is blocked, nothing reaches the network. The analysis sanitizer is replaced by an
 * identity function here so hostile markup reaches Chromium unfiltered — the browser-level
 * controls must hold on their own.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Browser } from "puppeteer-core";
import type { RenderJob } from "@edf/design";

vi.mock("@edf/sanitize", () => ({ sanitizeForAnalysis: (html: string) => html }));

const { defaultChromePath, launchChromium, loadAxeSource } = await import("../src/chromium");
const { renderEmail } = await import("../src/render-email");

const CHROME = defaultChromePath();

describe.skipIf(!existsSync(CHROME))("renderer isolation", () => {
  let server: http.Server;
  let hits: string[] = [];
  let base = "";
  let browser: Browser;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(200, { "content-type": "image/png" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await launchChromium({ executablePath: CHROME });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("blocks every non-data request and never runs page scripts", async () => {
    hits = [];
    const paragraph = "This paragraph must survive because page scripts never run in the renderer.";
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="${base}/link.css"><link rel="preload" href="${base}/preload.js" as="script">
<link rel="dns-prefetch" href="${base}"><meta http-equiv="refresh" content="0;url=${base}/refresh">
<style>@import url("${base}/import.css"); @font-face { font-family: X; src: url("${base}/font.woff2"); } body { background: url("${base}/bg.png"); font-family: X; }</style>
<script>document.body && (document.body.innerHTML = "HACKED"); fetch("${base}/fetch"); new Image().src = "${base}/js-img";</script>
<script src="${base}/external.js"></script>
</head><body>
<p>${paragraph}</p>
<img src="${base}/img.png" width="100" height="50" alt="x" onerror="fetch('${base}/onerror')">
<picture><source srcset="${base}/source.webp"><img src="${base}/picture.png"></picture>
<video poster="${base}/poster.png" src="${base}/video.mp4"></video>
<iframe src="${base}/frame"></iframe><object data="${base}/object"></object><embed src="${base}/embed">
<form action="${base}/form"><input type="image" src="${base}/input.png"></form>
<div style="background-image:image-set('${base}/set.png' 1x)">set</div>
<a href="${base}/click" ping="${base}/ping">link</a>
<svg><image href="${base}/svg-image.png"/></svg>
</body></html>`;
    const job: RenderJob = {
      id: "iso",
      html,
      images: {},
      cid: {},
      imageLog: {},
      imagesAllowed: true,
      wantAiTiles: false,
      lite: false,
    };
    const out = await renderEmail(browser, job, { axeSource: loadAxeSource() });
    expect(out.error).toBeNull();
    expect(out.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(hits).toEqual([]);
    // The page script would have replaced the body with "HACKED" (6 characters).
    expect(out.features!.text.chars.total).toBeGreaterThanOrEqual(60);
  }, 60_000);

  it("returns fixed error codes for oversized input", async () => {
    const job: RenderJob = {
      id: "big",
      html: `<p>${"x".repeat(2 * 1024 * 1024 + 10)}</p>`,
      images: {},
      cid: {},
      imageLog: {},
      imagesAllowed: true,
      wantAiTiles: false,
      lite: false,
    };
    const out = await renderEmail(browser, job, { axeSource: null });
    expect(out).toMatchObject({ ok: false, error: "too_large", features: null });
    const deep: RenderJob = {
      ...job,
      id: "deep",
      html: `<div>${"<span>a</span>".repeat(30_000)}</div>`,
    };
    expect((await renderEmail(browser, deep, { axeSource: null })).error).toBe("too_many_nodes");
  }, 60_000);
});
