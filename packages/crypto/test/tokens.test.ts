import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hmacSign,
  hmacVerify,
  parseKeyring,
  parseViewToken,
  signInvite,
  signOutLink,
  signViewToken,
  verifyInvite,
  verifyOutLink,
  verifyViewToken,
} from "../src/index";
import { nowSec, randomKey, ringJson } from "./helpers";

const k1 = randomKey();
const k2 = randomKey();
const ring = parseKeyring(ringJson({ v1: k1 }));
const rotated = parseKeyring(ringJson({ v1: k1, v2: k2 }));
const EMAIL = "0192f0c4-7a1b-7c3d-9e8f-001122334455";

describe("hmacSign/hmacVerify", () => {
  it("round-trips and binds every part", () => {
    const { kid, sig } = hmacSign(ring, ["a", 1]);
    expect(kid).toBe("v1");
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hmacVerify(ring, kid, sig, ["a", 1])).toBe(true);
    expect(hmacVerify(ring, kid, sig, ["a", 2])).toBe(false);
    expect(hmacVerify(ring, kid, sig, ["a", "1"])).toBe(false);
    expect(hmacVerify(ring, kid, sig, ["a"])).toBe(false);
    expect(hmacVerify(ring, "v9", sig, ["a", 1])).toBe(false);
  });
  it("rejects non-canonical or malformed signatures without throwing", () => {
    const { kid, sig } = hmacSign(ring, ["x"]);
    for (const bad of [
      "",
      sig + "A",
      sig.slice(1),
      `${sig.slice(0, 42)}=`,
      sig.replace(/./, "+"),
      "🙂",
    ]) {
      expect(hmacVerify(ring, kid, bad, ["x"])).toBe(false);
    }
    expect(hmacVerify(ring, kid, sig, [1.5])).toBe(false);
    expect(hmacVerify(ring, kid, sig, [Number.NaN])).toBe(false);
  });
});

describe("view tokens", () => {
  it("signs {kid}.{exp}.{mode}.{sig} and verifies for the right user/email only", () => {
    const exp = nowSec() + 240;
    const t = signViewToken(ring, { userId: "u1", emailId: EMAIL, exp, mode: "img" });
    expect(t).toMatch(/^v1\.\d+\.img\.[A-Za-z0-9_-]{43}$/);
    expect(parseViewToken(t)).toMatchObject({ kid: "v1", exp, mode: "img" });
    expect(verifyViewToken(ring, t, { userId: "u1", emailId: EMAIL, nowSec: nowSec() })).toEqual({
      mode: "img",
    });
    expect(verifyViewToken(ring, t, { userId: "u2", emailId: EMAIL, nowSec: nowSec() })).toBeNull();
    expect(
      verifyViewToken(ring, t, { userId: "u1", emailId: "other", nowSec: nowSec() }),
    ).toBeNull();
  });

  it("binds the mode (no img/noimg swap)", () => {
    const t = signViewToken(ring, {
      userId: "u1",
      emailId: EMAIL,
      exp: nowSec() + 100,
      mode: "noimg",
    });
    const swapped = t.replace(".noimg.", ".img.");
    expect(
      verifyViewToken(ring, swapped, { userId: "u1", emailId: EMAIL, nowSec: nowSec() }),
    ).toBeNull();
  });

  it("signs the gallery's card mode, and a card token can't be turned into a full-image one", () => {
    const t = signViewToken(ring, { userId: "u1", emailId: EMAIL, exp: nowSec() + 100, mode: "card" });
    expect(verifyViewToken(ring, t, { userId: "u1", emailId: EMAIL, nowSec: nowSec() })).toEqual({
      mode: "card",
    });
    const swapped = t.replace(".card.", ".img.");
    expect(
      verifyViewToken(ring, swapped, { userId: "u1", emailId: EMAIL, nowSec: nowSec() }),
    ).toBeNull();
  });

  it("enforces nowSec ≤ exp ≤ nowSec + 300 exactly", () => {
    const exp = nowSec() + 300;
    const t = signViewToken(ring, { userId: "u1", emailId: EMAIL, exp, mode: "img" });
    const c = { userId: "u1", emailId: EMAIL };
    expect(verifyViewToken(ring, t, { ...c, nowSec: exp })).not.toBeNull();
    expect(verifyViewToken(ring, t, { ...c, nowSec: exp + 1 })).toBeNull();
    expect(verifyViewToken(ring, t, { ...c, nowSec: exp - 300 })).not.toBeNull();
    expect(verifyViewToken(ring, t, { ...c, nowSec: exp - 301 })).toBeNull();
  });

  it("refuses to mint expired or far-future tokens", () => {
    const base = { userId: "u1", emailId: EMAIL, mode: "img" as const };
    expect(() => signViewToken(ring, { ...base, exp: nowSec() - 1 })).toThrow();
    expect(() => signViewToken(ring, { ...base, exp: nowSec() + 301 })).toThrow();
    expect(() => signViewToken(ring, { ...base, exp: nowSec() + 10, emailId: "../x" })).toThrow();
  });

  it("supports rotation: old kid verifies, new kid signs", () => {
    const exp = nowSec() + 200;
    const old = signViewToken(ring, { userId: "u", emailId: EMAIL, exp, mode: "img" });
    expect(
      verifyViewToken(rotated, old, { userId: "u", emailId: EMAIL, nowSec: nowSec() }),
    ).not.toBeNull();
    const fresh = signViewToken(rotated, { userId: "u", emailId: EMAIL, exp, mode: "img" });
    expect(fresh.startsWith("v2.")).toBe(true);
    expect(
      verifyViewToken(ring, fresh, { userId: "u", emailId: EMAIL, nowSec: nowSec() }),
    ).toBeNull();
  });

  it("fuzz: random mutations and garbage never verify and never throw", () => {
    const t = signViewToken(ring, {
      userId: "u1",
      emailId: EMAIL,
      exp: nowSec() + 200,
      mode: "img",
    });
    const c = { userId: "u1", emailId: EMAIL, nowSec: nowSec() };
    const alphabet = "AZaz09-_.+/=%\u0000 🙂";
    for (let i = 0; i < 2000; i++) {
      const chars = [...t];
      const pos = randomBytes(1)[0]! % chars.length;
      chars[pos] = alphabet[randomBytes(1)[0]! % alphabet.length]!;
      const m = chars.join("");
      if (m === t) continue;
      expect(verifyViewToken(ring, m, c)).toBeNull();
    }
    for (const g of [
      "",
      ".",
      "...",
      "v1.1.img.",
      `v1.0${c.nowSec}.img.${"A".repeat(43)}`,
      "x".repeat(10_000),
      `v1.${c.nowSec + 100}.IMG.${"A".repeat(43)}`,
    ]) {
      expect(parseViewToken(g) === null || verifyViewToken(ring, g, c) === null).toBe(true);
      expect(verifyViewToken(ring, g, c)).toBeNull();
    }
    expect(verifyViewToken(ring, t, { ...c, nowSec: Number.NaN })).toBeNull();
  });
});

describe("invites", () => {
  it("round-trips a normalized email and checks expiry and the 30-day cap", () => {
    const exp = nowSec() + 7 * 86_400;
    const t = signInvite(ring, { email: "  Friend@Example.COM ", exp });
    expect(verifyInvite(ring, t, nowSec())).toEqual({ email: "friend@example.com" });
    expect(verifyInvite(ring, t, exp + 1)).toBeNull();
    expect(() => signInvite(ring, { email: "a@b.c", exp: nowSec() + 31 * 86_400 })).toThrow();
    expect(() => signInvite(ring, { email: "no-at-sign", exp })).toThrow();
    expect(() => signInvite(ring, { email: "a b@c.d", exp })).toThrow();
  });
  it("rejects an email swap", () => {
    const t = signInvite(ring, { email: "a@example.com", exp: nowSec() + 100 });
    const parts = t.split(".");
    parts[2] = Buffer.from("b@example.com").toString("base64url");
    expect(verifyInvite(ring, parts.join("."), nowSec())).toBeNull();
    expect(verifyInvite(ring, "garbage", nowSec())).toBeNull();
  });
});

describe("/out links", () => {
  it("binds session, url and expiry", () => {
    const exp = nowSec() + 3600;
    const url = "https://shop.example/sale?x=1";
    const t = signOutLink(ring, { sessionId: "s1", url, exp });
    expect(t).toMatch(/^v1\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyOutLink(ring, t, { sessionId: "s1", url, nowSec: nowSec() })).toBe(true);
    expect(verifyOutLink(ring, t, { sessionId: "s2", url, nowSec: nowSec() })).toBe(false);
    expect(verifyOutLink(ring, t, { sessionId: "s1", url: `${url}&y`, nowSec: nowSec() })).toBe(
      false,
    );
    expect(verifyOutLink(ring, t, { sessionId: "s1", url, nowSec: exp + 1 })).toBe(false);
  });
  it("only signs http(s) and mailto URLs", () => {
    const exp = nowSec() + 60;
    expect(() => signOutLink(ring, { sessionId: "s", url: "javascript:alert(1)", exp })).toThrow();
    expect(() => signOutLink(ring, { sessionId: "s", url: "/relative", exp })).toThrow();
    expect(signOutLink(ring, { sessionId: "s", url: "mailto:a@b.example", exp })).toBeTruthy();
  });
});
