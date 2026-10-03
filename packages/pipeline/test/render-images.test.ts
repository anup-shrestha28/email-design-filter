/**
 * The render's image pre-fetch (FREE-TIER.md §5.1 step 3): the 5 MB per-image limit inside the
 * 15 MB email budget, and a reason logged for every image that isn't inlined — the policy's refusal,
 * the spent budget, our size/pixel limits, an SVG, an expired signed link, the fetch failure.
 * No database, no network: `fetchImage` is mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchImage = vi.hoisted(() => vi.fn());
vi.mock("@edf/fetch", () => ({ fetchImage }));

import {
  EMAIL_IMAGE_BUDGET,
  IMAGE_MAX_BYTES,
  failedFetchLog,
  prefetchImages,
  signedUrlExpired,
} from "../src/render";

const NOW = new Date("2026-09-30T12:00:00Z");
const nowSec = NOW.getTime() / 1000;
const MB = 1024 * 1024;

function ok(bytes: number) {
  return {
    ok: true,
    format: "png",
    width: 600,
    height: 400,
    contentType: "image/png",
    body: Buffer.alloc(bytes),
  };
}

const img = (src: string, attrs = 'width="600" height="400"') =>
  `<img src="${src}" ${attrs} alt="">`;

describe("prefetchImages", () => {
  beforeEach(() => fetchImage.mockReset());

  it("fetches up to 5 MB per image (a 4.6 MB PNG is inlined), within the 15 MB email budget", async () => {
    expect(IMAGE_MAX_BYTES).toBe(5 * MB);
    expect(EMAIL_IMAGE_BUDGET).toBe(15 * MB);
    fetchImage.mockResolvedValue(ok(Math.round(4.6 * MB)));
    const r = await prefetchImages(img("https://cdn.example.com/poster.png"), {
      userAddresses: ["reader@example.org"],
      imagesAllowed: true,
      now: NOW,
    });
    expect(fetchImage).toHaveBeenCalledWith("https://cdn.example.com/poster.png", {
      maxBytes: 5 * MB,
      timeoutMs: 5_000,
    });
    expect(Object.keys(r.images)).toEqual(["https://cdn.example.com/poster.png"]);
    expect(r.imageLog["https://cdn.example.com/poster.png"]).toEqual({
      status: 200,
      bytes: Math.round(4.6 * MB),
    });
  });

  it("logs why each image wasn't inlined", async () => {
    const urls = {
      pixels: "https://cdn.example.com/huge.png",
      big: "https://cdn.example.com/big.png",
      svg: "https://cdn.example.com/logo.svg",
      gone: "https://cdn.example.com/gone.png",
      expired: `https://media.example.net/image/abc?e=${Math.floor(nowSec) - 3600}&v=beta&t=x`,
      forbidden: `https://media.example.net/image/def?e=${Math.floor(nowSec) + 3600}&v=beta&t=x`,
      slow: "https://cdn.example.com/slow.png",
      dns: "https://nowhere.example.com/a.png",
      tracker: "https://mailtrack.io/trace/abc.png",
      recipient: "https://cdn.example.com/banner.png?to=reader%40example.org",
    };
    // (Implementations never throw and tolerate no arguments: vitest may call them bare.)
    fetchImage.mockImplementation(async (url?: string) => {
      if (url === urls.pixels) return { ok: false, reason: "too_many_pixels", status: 200 };
      if (url === urls.big) return { ok: false, reason: "too_large", status: 200 };
      if (url === urls.svg) return { ok: false, reason: "not_image", status: 200, svg: true };
      if (url === urls.gone) return { ok: false, reason: "http", status: 404 };
      if (url === urls.expired || url === urls.forbidden)
        return { ok: false, reason: "http", status: 403 };
      if (url === urls.slow) return { ok: false, reason: "timeout" };
      if (url === urls.dns) return { ok: false, reason: "dns" };
      return { ok: false, reason: "network" };
    });
    const html = Object.values(urls)
      .map((u) => img(u.replace(/&/g, "&amp;")))
      .join("");
    const r = await prefetchImages(html, {
      userAddresses: ["reader@example.org"],
      imagesAllowed: true,
      now: NOW,
    });
    expect(r.images).toEqual({});
    // The policy refusals are never fetched.
    const fetched = fetchImage.mock.calls.map((c) => c[0] as string);
    expect(fetched).not.toContain(urls.tracker);
    expect(fetched).not.toContain(urls.recipient);
    expect(fetched).toHaveLength(8);
    const log = (u: string) => r.imageLog[u];
    expect(log(urls.pixels)).toEqual({ status: "too_large", bytes: 0, reason: "too_many_pixels" });
    expect(log(urls.big)).toEqual({ status: "too_large", bytes: 0, reason: "too_large" });
    expect(log(urls.svg)).toEqual({ status: 200, bytes: 0, reason: "svg" });
    expect(log(urls.gone)).toEqual({ status: 404, bytes: 0, reason: "http" });
    expect(log(urls.expired)).toEqual({ status: 403, bytes: 0, reason: "expired" });
    expect(log(urls.forbidden)).toEqual({ status: 403, bytes: 0, reason: "http" });
    expect(log(urls.slow)).toEqual({ status: "timeout", bytes: 0, reason: "timeout" });
    expect(log(urls.dns)).toEqual({ status: "error", bytes: 0, reason: "network" });
    expect(log(urls.tracker)).toEqual({ status: "blocked", bytes: 0, reason: "tracker" });
    expect(log(urls.recipient)).toEqual({ status: "blocked", bytes: 0, reason: "per_recipient" });
  });

  it("inlines at most the 15 MB budget; the rest are logged as budget, not as broken", async () => {
    // Five 5 MB images, four fetched at once: three fit, the other two are over the budget.
    fetchImage.mockImplementation(async (_url?: string, opts?: { maxBytes: number }) =>
      (opts?.maxBytes ?? 0) < 5 * MB ? { ok: false, reason: "too_large" } : ok(5 * MB),
    );
    const html = [1, 2, 3, 4, 5].map((n) => img(`https://cdn.example.com/${n}.png`)).join("");
    const r = await prefetchImages(html, { userAddresses: [], imagesAllowed: true, now: NOW });
    expect(Object.keys(r.images)).toHaveLength(3);
    const rest = Object.values(r.imageLog).filter((e) => e.status !== 200);
    expect(rest).toHaveLength(2);
    for (const e of rest) expect(e).toMatchObject({ bytes: 0, reason: "budget" });
    // Four: the fourth finds the budget spent (refused before its fetch, or dropped after it).
    const three = [1, 2, 3].map((n) => img(`https://cdn.example.com/f${n}.png`)).join("");
    const full = await prefetchImages(`${three}${img("https://cdn.example.com/f4.png")}`, {
      userAddresses: [],
      imagesAllowed: true,
      now: NOW,
    });
    expect(Object.keys(full.images)).toHaveLength(3);
    expect(full.imageLog["https://cdn.example.com/f4.png"]).toMatchObject({ reason: "budget" });
  });

  it("images off: nothing is fetched or logged", async () => {
    const r = await prefetchImages(img("https://cdn.example.com/a.png"), {
      userAddresses: [],
      imagesAllowed: false,
    });
    expect(r).toEqual({ images: {}, imageLog: {} });
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

describe("signedUrlExpired / failedFetchLog", () => {
  it("reads the common signed-URL expiries", () => {
    const past = Math.floor(nowSec) - 60;
    const future = Math.floor(nowSec) + 60;
    expect(signedUrlExpired(`https://m.example.net/a?e=${past}`, NOW)).toBe(true);
    expect(signedUrlExpired(`https://m.example.net/a?e=${future}`, NOW)).toBe(false);
    expect(signedUrlExpired(`https://d.example.net/a?Expires=${past}&Signature=x`, NOW)).toBe(true);
    expect(
      signedUrlExpired(
        "https://b.example.net/a?X-Amz-Date=20260930T100000Z&X-Amz-Expires=3600&X-Amz-Signature=x",
        NOW,
      ),
    ).toBe(true);
    expect(
      signedUrlExpired(
        "https://b.example.net/a?X-Amz-Date=20260930T113000Z&X-Amz-Expires=3600&X-Amz-Signature=x",
        NOW,
      ),
    ).toBe(false);
    // Not an expiry: a flag, a short number, no parameters, not a URL.
    expect(signedUrlExpired("https://m.example.net/a?e=1", NOW)).toBe(false);
    expect(signedUrlExpired("https://m.example.net/a.png", NOW)).toBe(false);
    expect(signedUrlExpired("not a url", NOW)).toBe(false);
  });

  it("an expired signature only explains 401/403/410", () => {
    const url = `https://m.example.net/a?e=${Math.floor(nowSec) - 60}`;
    expect(failedFetchLog({ reason: "http", status: 410 }, url, NOW).reason).toBe("expired");
    expect(failedFetchLog({ reason: "http", status: 500 }, url, NOW).reason).toBe("http");
    expect(failedFetchLog({ reason: "not_image", status: 200 }, url, NOW)).toEqual({
      status: 200,
      bytes: 0,
      reason: "not_image",
    });
  });
});
