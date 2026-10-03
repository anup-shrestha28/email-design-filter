import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CryptoConfigError,
  CryptoError,
  IMAGE_TOKEN_MAX_BYTES,
  IMAGE_TOKEN_MAX_LIFETIME_SEC,
  imageTokenExpiry,
  parseEd25519SigningRing,
  parseEd25519VerifyRing,
  signImageToken,
  verifyImageToken,
  type ImageTokenClaims,
} from "../src/index";
import { ed25519Pair, nowSec } from "./helpers";

const k1 = ed25519Pair();
const k2 = ed25519Pair();
const signing = parseEd25519SigningRing(JSON.stringify({ v1: k1.privDer }));
const verifying = parseEd25519VerifyRing(JSON.stringify({ v1: k1.pubDer }));

function claims(over: Partial<ImageTokenClaims> = {}): ImageTokenClaims {
  return {
    u: "user_123",
    e: "0192f0c4-7a1b-7c3d-9e8f-001122334455",
    x: imageTokenExpiry(new Date()),
    url: "https://cdn.shop.example/hero.png?w=600",
    mb: 1_000_000,
    b: "bud-1",
    ...over,
  };
}

describe("Ed25519 rings", () => {
  it("parses PEM and base64 DER", () => {
    expect(
      parseEd25519SigningRing(JSON.stringify({ a: k1.privPem, b: k2.privDer }), "a").active,
    ).toBe("a");
    expect(parseEd25519VerifyRing(JSON.stringify({ a: k1.pubPem, b: k2.pubDer })).keys.size).toBe(
      2,
    );
  });
  it("refuses private keys in IMG_PUBKEYS and non-Ed25519 keys", () => {
    expect(() => parseEd25519VerifyRing(JSON.stringify({ v1: k1.privPem }))).toThrow(
      CryptoConfigError,
    );
    expect(() => parseEd25519VerifyRing(JSON.stringify({ v1: k1.privDer }))).toThrow(
      CryptoConfigError,
    );
    expect(() => parseEd25519SigningRing(JSON.stringify({ v1: k1.pubDer }))).toThrow(
      CryptoConfigError,
    );
    expect(() => parseEd25519SigningRing(JSON.stringify({ v1: "AAAA" }))).toThrow(
      CryptoConfigError,
    );
  });
});

describe("image tokens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips with the documented format", () => {
    const c = claims();
    const t = signImageToken(signing, c);
    const [kid, payload, sig] = t.split(".");
    expect(kid).toBe("v1");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual([
      "img/v1",
      c.u,
      c.e,
      c.x,
      c.url,
      c.mb,
      c.b,
    ]);
    expect(Buffer.from(sig!, "base64url").length).toBe(64);
    expect(verifyImageToken(verifying, t, nowSec())).toEqual(c);
  });

  it("rejects a token signed by another key, an unknown kid, and any byte flip", () => {
    const other = parseEd25519SigningRing(JSON.stringify({ v1: k2.privDer }));
    expect(verifyImageToken(verifying, signImageToken(other, claims()), nowSec())).toBeNull();
    const t = signImageToken(signing, claims());
    expect(verifyImageToken(verifying, `v2${t.slice(2)}`, nowSec())).toBeNull();
    for (let i = 0; i < t.length; i++) {
      if (t[i] === ".") continue;
      const flipped = t.slice(0, i) + (t[i] === "A" ? "B" : "A") + t.slice(i + 1);
      expect(verifyImageToken(verifying, flipped, nowSec())).toBeNull();
    }
  });

  it("enforces expiry and the 48 h (+5 min) ceiling", () => {
    const t = signImageToken(signing, claims({ x: nowSec() + 10 }));
    expect(verifyImageToken(verifying, t, nowSec())).not.toBeNull();
    expect(verifyImageToken(verifying, t, nowSec() + 11)).toBeNull();
    // Signed on a clock two hours fast: 49 h ahead of the verifier, past its ceiling.
    const real = nowSec();
    vi.useFakeTimers({ toFake: ["Date"], now: (real + 2 * 3600) * 1000 });
    const far = signImageToken(signing, claims({ x: real + 49 * 3600 }));
    vi.useRealTimers();
    expect(verifyImageToken(verifying, far, real)).toBeNull();
  });

  it("refuses to sign an expiry outside (now, now + 48 h]", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: 1_790_000_000_500 });
    const now = 1_790_000_000;
    for (const x of [1, now - 60, now, now + IMAGE_TOKEN_MAX_LIFETIME_SEC + 1, now * 1000]) {
      expect(() => signImageToken(signing, claims({ x }))).toThrow(CryptoError);
    }
    expect(() => signImageToken(signing, claims({ x: now + 1 }))).not.toThrow();
    expect(() =>
      signImageToken(signing, claims({ x: now + IMAGE_TOKEN_MAX_LIFETIME_SEC })),
    ).not.toThrow();
    // imageTokenExpiry's longest lifetime (exactly UTC midnight) is still signable.
    vi.setSystemTime(Date.UTC(2026, 8, 27));
    expect(() => signImageToken(signing, claims({ x: imageTokenExpiry(new Date()) }))).not.toThrow();
  });

  it("refuses to sign invalid claims", () => {
    expect(() => signImageToken(signing, claims({ mb: IMAGE_TOKEN_MAX_BYTES + 1 }))).toThrow();
    expect(() => signImageToken(signing, claims({ mb: 0 }))).toThrow();
    expect(() => signImageToken(signing, claims({ url: "javascript:alert(1)" }))).toThrow();
    expect(() =>
      signImageToken(signing, claims({ url: "https://User:pw@x.example/a.png" })),
    ).toThrow();
    expect(() => signImageToken(signing, claims({ url: "HTTPS://X.EXAMPLE/a.png" }))).toThrow(); // not normalized
    expect(() =>
      signImageToken(signing, claims({ url: `https://x.example/${"a".repeat(3000)}` })),
    ).toThrow();
    expect(() => signImageToken(signing, claims({ e: "../../x" }))).toThrow();
  });

  it("never throws on garbage", () => {
    for (const g of [
      "",
      "..",
      "a.b.c",
      "v1.%%%.@@@",
      "v1..",
      "x".repeat(5000),
      `v1.${Buffer.from("[]").toString("base64url")}.${"A".repeat(86)}`,
    ]) {
      expect(verifyImageToken(verifying, g, nowSec())).toBeNull();
    }
  });
});

describe("imageTokenExpiry", () => {
  it("is the next UTC midnight + 24 h", () => {
    expect(imageTokenExpiry(new Date("2026-09-27T13:45:00Z"))).toBe(
      Date.parse("2026-09-29T00:00:00Z") / 1000,
    );
    expect(imageTokenExpiry(new Date("2026-09-27T00:00:00Z"))).toBe(
      Date.parse("2026-09-29T00:00:00Z") / 1000,
    );
    expect(imageTokenExpiry(new Date("2026-09-27T23:59:59.999Z"))).toBe(
      Date.parse("2026-09-29T00:00:00Z") / 1000,
    );
    expect(() => imageTokenExpiry(new Date(Number.NaN))).toThrow();
  });
});
