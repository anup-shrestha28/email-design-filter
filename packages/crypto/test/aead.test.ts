import { describe, expect, it } from "vitest";
import {
  CryptoConfigError,
  compareKids,
  constantTimeEqual,
  encodeAad,
  keyringKidOf,
  open,
  openWithKeyring,
  parseKeyring,
  seal,
  sealWithKeyring,
} from "../src/index";
import { randomKey, ringJson } from "./helpers";

const AAD = ["mbx-1", "user-1", "refresh"];

describe("encodeAad", () => {
  it("length-prefixes each part big-endian", () => {
    expect(encodeAad(["ab", ""]).toString("hex")).toBe("00000002616200000000");
    expect(encodeAad(["é"]).toString("hex")).toBe("00000002c3a9");
  });
  it("is injective where naive joining is not", () => {
    expect(encodeAad(["a|b", "c"]).equals(encodeAad(["a", "b|c"]))).toBe(false);
    expect(encodeAad(["ab", "c"]).equals(encodeAad(["a", "bc"]))).toBe(false);
  });
  it("rejects lone surrogates and non-strings", () => {
    expect(() => encodeAad(["\uD800"])).toThrow();
    expect(() => encodeAad([1 as unknown as string])).toThrow();
  });
});

describe("seal/open (v1)", () => {
  const key = randomKey();

  it("round-trips strings and bytes with the documented layout", () => {
    const s = seal(key, "refresh-token", AAD);
    expect(s[0]).toBe(0x01);
    expect(s.length).toBe(1 + 12 + "refresh-token".length + 16);
    expect(open(key, s, AAD).toString()).toBe("refresh-token");
    const bytes = randomKey();
    expect(open(key, seal(key, bytes, AAD), AAD).equals(bytes)).toBe(true);
  });

  it("uses a fresh random nonce each time", () => {
    const a = seal(key, "x", AAD);
    const b = seal(key, "x", AAD);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
  });

  it("detects every single-bit flip in every byte", () => {
    const s = seal(key, "tamper-me-please", AAD);
    for (let i = 0; i < s.length; i++) {
      for (let bit = 0; bit < 8; bit++) {
        const t = Buffer.from(s);
        t[i] = (t[i] as number) ^ (1 << bit);
        expect(() => open(key, t, AAD)).toThrow();
      }
    }
  });

  it("rejects truncation and extension", () => {
    const s = seal(key, "abc", AAD);
    for (let n = 0; n < s.length; n++) expect(() => open(key, s.subarray(0, n), AAD)).toThrow();
    expect(() => open(key, Buffer.concat([s, Buffer.from([0])]), AAD)).toThrow();
  });

  it("rejects wrong key and wrong AAD (value, order, count)", () => {
    const s = seal(key, "abc", AAD);
    expect(() => open(randomKey(), s, AAD)).toThrow();
    expect(() => open(key, s, ["mbx-2", "user-1", "refresh"])).toThrow();
    expect(() => open(key, s, ["user-1", "mbx-1", "refresh"])).toThrow();
    expect(() => open(key, s, ["mbx-1", "user-1"])).toThrow();
    expect(() => open(key, s, ["mbx-1", "user-1", "refresh", ""])).toThrow();
  });

  it("refuses bad keys and empty AAD", () => {
    expect(() => seal(Buffer.alloc(16), "x", AAD)).toThrow();
    expect(() => seal(key, "x", [])).toThrow();
    expect(() => open(key, seal(key, "x", AAD), [])).toThrow();
  });
});

describe("keyrings", () => {
  const k1 = randomKey();
  const k2 = randomKey();

  it("parses and defaults active to the greatest kid in natural order", () => {
    const ring = parseKeyring(ringJson({ v9: k1, v10: k2 }));
    expect(ring.active).toBe("v10");
    expect(parseKeyring(ringJson({ v1: k1, v2: k2 }), "v1").active).toBe("v1");
    expect(compareKids("v2", "v10")).toBeLessThan(0);
    expect(compareKids("v10", "v10")).toBe(0);
  });

  it("accepts url-safe/unpadded base64 and rejects wrong lengths and garbage", () => {
    expect(
      parseKeyring(JSON.stringify({ v1: k1.toString("base64url") }))
        .keys.get("v1")
        ?.equals(k1),
    ).toBe(true);
    expect(() => parseKeyring(ringJson({ v1: randomKey().subarray(0, 31) }))).toThrow(
      CryptoConfigError,
    );
    expect(() => parseKeyring(JSON.stringify({ v1: "not base64!!" }))).toThrow(CryptoConfigError);
    expect(() => parseKeyring("{")).toThrow(CryptoConfigError);
    expect(() => parseKeyring("[]")).toThrow(CryptoConfigError);
    expect(() => parseKeyring("{}")).toThrow(CryptoConfigError);
    expect(() => parseKeyring(JSON.stringify({ "v.1": k1.toString("base64") }))).toThrow(
      CryptoConfigError,
    );
    expect(() => parseKeyring(ringJson({ v1: k1 }), "v2")).toThrow(CryptoConfigError);
  });

  it("never puts key material in error messages", () => {
    const secret = randomKey().subarray(0, 31).toString("base64");
    try {
      parseKeyring(JSON.stringify({ v1: secret }));
    } catch (e) {
      expect(String(e)).not.toContain(secret);
    }
  });

  it("seals with the active kid, opens with any kid (rotation)", () => {
    const old = parseKeyring(ringJson({ v1: k1 }));
    const rotated = parseKeyring(ringJson({ v1: k1, v2: k2 }));
    const sealedOld = sealWithKeyring(old, "access-token", AAD);
    expect(keyringKidOf(sealedOld)).toBe("v1");
    expect(openWithKeyring(rotated, sealedOld, AAD).toString()).toBe("access-token");
    const sealedNew = sealWithKeyring(rotated, "access-token", AAD);
    expect(sealedNew[0]).toBe(0x02);
    expect(sealedNew[1]).toBe(2);
    expect(sealedNew.subarray(2, 4).toString()).toBe("v2");
    expect(keyringKidOf(sealedNew)).toBe("v2");
    expect(() => openWithKeyring(old, sealedNew, AAD)).toThrow();
  });

  it("detects tampering including kid swaps", () => {
    const ring = parseKeyring(ringJson({ v1: k1, v2: k1 }));
    const s = sealWithKeyring(ring, "x", AAD);
    for (let i = 0; i < s.length; i++) {
      const t = Buffer.from(s);
      t[i] = (t[i] as number) ^ 0x01;
      expect(() => openWithKeyring(ring, t, AAD)).toThrow();
    }
    // Same key bytes under another kid: the header is authenticated, so the swap fails.
    const swapped = Buffer.from(s);
    swapped.write("v1", 2);
    expect(() => openWithKeyring(ring, swapped, AAD)).toThrow();
    expect(() => openWithKeyring(ring, s, ["other"])).toThrow();
    expect(() => open(k1, s, AAD)).toThrow();
  });
});

describe("constantTimeEqual", () => {
  it("compares bytes and strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual(Buffer.from([1, 2]), new Uint8Array([1, 2]))).toBe(true);
  });
});
