import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sniffImage } from "../src/index";
import { AVIF, HEIC, SVG, gif, jpeg, png, webpExtended, webpLossless, webpLossy } from "./images";

describe("sniffImage", () => {
  it("reads PNG IHDR", () => {
    expect(sniffImage(png(640, 480))).toEqual({ format: "png", width: 640, height: 480 });
  });
  it("scans JPEG segments to SOFn (with fill bytes, big APP1, progressive)", () => {
    expect(sniffImage(jpeg(1200, 800))).toEqual({ format: "jpeg", width: 1200, height: 800 });
    expect(sniffImage(jpeg(10, 20, { app1Bytes: 60_000, progressive: true }))).toEqual({
      format: "jpeg",
      width: 10,
      height: 20,
    });
  });
  it("reads the GIF logical screen, enlarged by the first frame", () => {
    expect(sniffImage(gif(100, 50))).toEqual({ format: "gif", width: 100, height: 50 });
    expect(sniffImage(gif(1, 1, { left: 0, top: 0, w: 60000, h: 60000 }))).toEqual({
      format: "gif",
      width: 60000,
      height: 60000,
    });
  });
  it("reads WebP VP8, VP8L and VP8X", () => {
    expect(sniffImage(webpLossy(300, 200))).toEqual({ format: "webp", width: 300, height: 200 });
    expect(sniffImage(webpLossless(16384, 1))).toEqual({ format: "webp", width: 16384, height: 1 });
    expect(sniffImage(webpExtended(5000, 7000))).toEqual({
      format: "webp",
      width: 5000,
      height: 7000,
    });
  });
  it("rejects SVG, AVIF, HEIF, zero sizes and truncations", () => {
    for (const b of [
      SVG,
      AVIF,
      HEIC,
      png(0, 10),
      jpeg(10, 0),
      Buffer.from("GIF89a"),
      Buffer.alloc(0),
    ]) {
      expect(sniffImage(b)).toBeNull();
    }
    const full = png(10, 10);
    for (let n = 0; n < 33; n++) expect(sniffImage(full.subarray(0, n))).toBeNull();
    const j = jpeg(10, 10);
    for (let n = 0; n < j.length - 6; n++) expect(sniffImage(j.subarray(0, n))).toBeNull();
  });
  it("never throws on random or adversarial input", () => {
    const prefixes = [
      png(1, 1).subarray(0, 8),
      Buffer.from([0xff, 0xd8, 0xff]),
      Buffer.from("GIF89a"),
      Buffer.from("RIFF\0\0\0\0WEBP"),
    ];
    for (let i = 0; i < 3000; i++) {
      const prefix = prefixes[i % prefixes.length]!;
      const b = Buffer.concat([prefix, randomBytes(i % 200)]);
      expect(() => sniffImage(b)).not.toThrow();
    }
  });
});
