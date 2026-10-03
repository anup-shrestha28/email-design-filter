import { createHmac, createPublicKey } from "node:crypto";
import { SignJWT, importJWK } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CryptoConfigError,
  LocalKeyWrapper,
  createDevOidcIssuer,
  createOidcVerifier,
  importDevOidcIssuer,
  mintDevOidcToken,
  parseKeyring,
} from "../src/index";
import { nowSec, randomKey, ringJson } from "./helpers";

const dev = await createDevOidcIssuer({ issuer: "https://oidc.vercel.com/acme" });
const expect_ = {
  issuer: "https://oidc.vercel.com/acme",
  audience: "https://vercel.com/acme",
  subject: "owner:acme:project:edf-app:environment:production",
};
const verify = createOidcVerifier(expect_, { jwks: dev.jwks });
const mint = (over: Partial<Parameters<typeof mintDevOidcToken>[1]> = {}) =>
  mintDevOidcToken(dev, { sub: expect_.subject, aud: expect_.audience, ...over });

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createOidcVerifier (local JWKS)", () => {
  it("accepts a valid 2-hour function token", async () => {
    expect(await verify(await mint())).toEqual({ sub: expect_.subject });
  });

  it("rejects wrong iss, aud, sub", async () => {
    expect(await verify(await mint({ issuer: "https://oidc.vercel.com/evil" }))).toBeNull();
    expect(await verify(await mint({ aud: "https://vercel.com/evil" }))).toBeNull();
    expect(
      await verify(await mint({ sub: "owner:acme:project:edf-view:environment:production" })),
    ).toBeNull();
    expect(
      await verify(await mint({ sub: "owner:acme:project:edf-app:environment:preview" })),
    ).toBeNull();
  });

  it("rejects 1-hour build tokens, 12-hour dev tokens and expired tokens", async () => {
    expect(await verify(await mint({ ttlSec: 3600 }))).toBeNull();
    expect(await verify(await mint({ ttlSec: 12 * 3600 }))).toBeNull();
    expect(await verify(await mint({ iat: nowSec() - 7300 }))).toBeNull();
    expect(await verify(await mint({ iat: nowSec() + 600 }))).toBeNull(); // issued in the future
  });

  it("rejects alg none and HS256 key confusion", async () => {
    const now = nowSec();
    const claims = {
      iss: expect_.issuer,
      aud: expect_.audience,
      sub: expect_.subject,
      iat: now,
      nbf: now,
      exp: now + 7200,
    };
    const none = `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claims)}.`;
    expect(await verify(none)).toBeNull();
    const pubPem = createPublicKey({ key: dev.jwks.keys[0] as never, format: "jwk" })
      .export({ format: "pem", type: "spki" })
      .toString();
    const header = b64u({ alg: "HS256", typ: "JWT", kid: dev.kid });
    const body = b64u(claims);
    const sig = createHmac("sha256", pubPem).update(`${header}.${body}`).digest("base64url");
    expect(await verify(`${header}.${body}.${sig}`)).toBeNull();
    const hs = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: dev.kid })
      .sign(Buffer.from(pubPem));
    expect(await verify(hs)).toBeNull();
  });

  it("rejects RS512 and a token from another key with the same kid", async () => {
    const other = await createDevOidcIssuer({ issuer: expect_.issuer });
    const forged = await mintDevOidcToken(
      { ...other, kid: dev.kid },
      { sub: expect_.subject, aud: expect_.audience },
    );
    expect(await verify(forged)).toBeNull();
    const now = nowSec();
    const rs512 = await new SignJWT({})
      .setProtectedHeader({ alg: "RS512", kid: dev.kid })
      .setIssuer(expect_.issuer)
      .setSubject(expect_.subject)
      .setAudience(expect_.audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 7200)
      .sign(await importJWK(dev.privateJwk, "RS512"));
    expect(await verify(rs512)).toBeNull();
  });

  it("rejects multi-audience tokens and garbage without throwing", async () => {
    expect(
      await verify(await mint({ aud: [expect_.audience, "x"] as unknown as string })),
    ).toBeNull();
    for (const g of ["", "a.b.c", "x".repeat(9000), "..", 42 as unknown as string]) {
      expect(await verify(g)).toBeNull();
    }
  });

  it("importDevOidcIssuer round-trips DEV_OIDC_PRIVATE_JWK", async () => {
    const again = importDevOidcIssuer(JSON.stringify(dev.privateJwk), dev.issuer);
    const t = await mintDevOidcToken(again, { sub: expect_.subject, aud: expect_.audience });
    expect(await verify(t)).toEqual({ sub: expect_.subject });
  });
});

describe("createOidcVerifier (discovery)", () => {
  const issuer = "https://oidc.test.example/acme";
  const exp2 = { ...expect_, issuer };

  function fakeFetch(doc: Record<string, unknown>, calls: string[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `${issuer}/.well-known/jwks`) {
        return new Response(JSON.stringify(dev.jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
  }

  it("resolves jwks_uri from the discovery document and caches it", async () => {
    const calls: string[] = [];
    const v = createOidcVerifier(exp2, {
      fetchImpl: fakeFetch({ issuer, jwks_uri: `${issuer}/.well-known/jwks` }, calls),
    });
    const t = await mintDevOidcToken(dev, { sub: exp2.subject, aud: exp2.audience, issuer });
    expect(await v(t)).toEqual({ sub: exp2.subject });
    expect(await v(t)).toEqual({ sub: exp2.subject });
    expect(calls.filter((c) => c.endsWith("openid-configuration"))).toHaveLength(1);
    expect(calls.filter((c) => c.endsWith("/jwks"))).toHaveLength(1);
  });

  it("fails closed on issuer mismatch or a jwks_uri on another origin or scheme", async () => {
    const t = await mintDevOidcToken(dev, { sub: exp2.subject, aud: exp2.audience, issuer });
    for (const doc of [
      { issuer: "https://oidc.test.example/other", jwks_uri: `${issuer}/.well-known/jwks` },
      { issuer, jwks_uri: "https://evil.example/jwks" },
      { issuer, jwks_uri: "http://oidc.test.example/acme/.well-known/jwks" },
      { issuer },
    ]) {
      const v = createOidcVerifier(exp2, { fetchImpl: fakeFetch(doc, []) });
      expect(await v(t)).toBeNull();
    }
  });

  it("does not hit the network for unsigned/garbage tokens", async () => {
    const calls: string[] = [];
    const v = createOidcVerifier(exp2, {
      fetchImpl: fakeFetch({ issuer, jwks_uri: `${issuer}/.well-known/jwks` }, calls),
    });
    expect(await v("garbage")).toBeNull();
    expect(await v(`${b64u({ alg: "none" })}.${b64u({})}.`)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("refuses a non-https issuer", () => {
    expect(() => createOidcVerifier({ ...exp2, issuer: "http://oidc.test.example/acme" })).toThrow(
      CryptoConfigError,
    );
    expect(() => createOidcVerifier({ ...exp2, issuer: `${issuer}/` })).toThrow(CryptoConfigError);
  });
});

describe("development-only guards", () => {
  it("refuse to run in production or on Vercel", async () => {
    for (const [k, v] of [
      ["NODE_ENV", "production"],
      ["VERCEL_ENV", "preview"],
      ["VERCEL", "1"],
    ] as const) {
      vi.stubEnv(k, v);
      await expect(createDevOidcIssuer()).rejects.toThrow(CryptoConfigError);
      await expect(mint()).rejects.toThrow(CryptoConfigError);
      expect(() => createOidcVerifier(expect_, { jwks: dev.jwks })).toThrow(CryptoConfigError);
      expect(() => new LocalKeyWrapper(parseKeyring(ringJson({ v1: randomKey() })))).toThrow(
        CryptoConfigError,
      );
      vi.unstubAllEnvs();
    }
  });
});
