import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoConfigError,
  KeyServiceError,
  KeyServiceWrapper,
  LocalKeyWrapper,
  WRAPPED_DEK_LENGTH,
  dekWrapAad,
  open,
  parseKeyring,
} from "../src/index";
import { randomKey, ringJson } from "./helpers";

const MBX = "0192f0c4-7a1b-7c3d-9e8f-001122334455";

describe("LocalKeyWrapper", () => {
  const k1 = randomKey();
  const k2 = randomKey();

  it("generates a 32-byte DEK wrapped with AAD [label, mailboxId, kekVersion]", async () => {
    const w = new LocalKeyWrapper(parseKeyring(ringJson({ v1: k1 })));
    const g = await w.generate({ mailboxId: MBX });
    expect(g.dek.length).toBe(32);
    expect(g.wrapped.length).toBe(WRAPPED_DEK_LENGTH);
    expect(g.kekVersion).toBe("local:v1");
    expect(open(k1, g.wrapped, dekWrapAad(MBX, "local:v1")).equals(g.dek)).toBe(true);
    const u = await w.unwrap({ mailboxId: MBX, wrapped: g.wrapped, kekVersion: g.kekVersion });
    expect(u.dek.equals(g.dek)).toBe(true);
    expect(u.rewrapped).toBeNull();
  });

  it("binds the mailbox id and kek version", async () => {
    const w = new LocalKeyWrapper(parseKeyring(ringJson({ v1: k1 })));
    const g = await w.generate({ mailboxId: MBX });
    await expect(
      w.unwrap({ mailboxId: "other", wrapped: g.wrapped, kekVersion: g.kekVersion }),
    ).rejects.toThrow();
    await expect(
      w.unwrap({ mailboxId: MBX, wrapped: g.wrapped, kekVersion: "local:v2" }),
    ).rejects.toThrow();
    await expect(
      w.unwrap({ mailboxId: MBX, wrapped: g.wrapped, kekVersion: "keys:v1" }),
    ).rejects.toThrow();
  });

  it("re-wraps lazily after rotation", async () => {
    const before = new LocalKeyWrapper(parseKeyring(ringJson({ v1: k1 })));
    const after = new LocalKeyWrapper(parseKeyring(ringJson({ v1: k1, v2: k2 })));
    const g = await before.generate({ mailboxId: MBX });
    const u = await after.unwrap({ mailboxId: MBX, wrapped: g.wrapped, kekVersion: g.kekVersion });
    expect(u.dek.equals(g.dek)).toBe(true);
    expect(u.rewrapped?.kekVersion).toBe("local:v2");
    const again = await after.unwrap({ mailboxId: MBX, ...u.rewrapped! });
    expect(again.dek.equals(g.dek)).toBe(true);
    expect(again.rewrapped).toBeNull();
  });
});

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
const json = (o: unknown, status = 200, ct = "application/json") =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": ct } });

function service(handler: Handler, getOidcToken = async () => "aaa.bbb.ccc") {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const w = new KeyServiceWrapper({
    origin: "https://edf-keys.example",
    getOidcToken,
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof fetch,
  });
  return { w, seen };
}

describe("KeyServiceWrapper", () => {
  const dek = randomBytes(32);
  const wrapped = randomBytes(WRAPPED_DEK_LENGTH);

  it("POSTs generate with the bearer token and no redirects", async () => {
    const { w, seen } = service(() =>
      json({
        dek: dek.toString("base64"),
        wrapped: wrapped.toString("base64"),
        kekVersion: "keys:v1",
      }),
    );
    const g = await w.generate({ mailboxId: MBX });
    expect(g.dek.equals(dek) && g.wrapped.equals(wrapped) && g.kekVersion === "keys:v1").toBe(true);
    const req = seen[0]!;
    expect(req.url).toBe("https://edf-keys.example/unwrap");
    expect(req.init.method).toBe("POST");
    expect(req.init.redirect).toBe("error");
    expect((req.init.headers as Record<string, string>).authorization).toBe("Bearer aaa.bbb.ccc");
    expect(JSON.parse(req.init.body as string)).toEqual({ op: "generate", mailboxId: MBX });
  });

  it("unwraps and passes through a lazy re-wrap", async () => {
    const newWrapped = randomBytes(WRAPPED_DEK_LENGTH);
    const { w, seen } = service(() =>
      json({
        dek: dek.toString("base64"),
        rewrapped: { wrapped: newWrapped.toString("base64"), kekVersion: "keys:v2" },
      }),
    );
    const u = await w.unwrap({ mailboxId: MBX, wrapped, kekVersion: "keys:v1" });
    expect(u.dek.equals(dek)).toBe(true);
    expect(u.rewrapped?.kekVersion).toBe("keys:v2");
    expect(u.rewrapped?.wrapped.equals(newWrapped)).toBe(true);
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({
      op: "unwrap",
      mailboxId: MBX,
      wrapped: wrapped.toString("base64"),
      kekVersion: "keys:v1",
    });
  });

  it("strictly validates responses", async () => {
    const bad: Array<() => Response> = [
      () => json({ dek: randomBytes(31).toString("base64"), rewrapped: null }),
      () => json({ dek: "!!!", rewrapped: null }),
      () =>
        json({
          dek: dek.toString("base64"),
          rewrapped: { wrapped: "AA==", kekVersion: "keys:v2" },
        }),
      () =>
        json({
          dek: dek.toString("base64"),
          rewrapped: { wrapped: wrapped.toString("base64"), kekVersion: "kms:1" },
        }),
      () => json({ dek: dek.toString("base64") }, 200, "text/html"),
      () => json({ error: "unauthorized" }, 401),
      () =>
        new Response("x".repeat(10_000), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => json([1, 2]),
    ];
    for (const b of bad) {
      const { w } = service(b);
      await expect(
        w.unwrap({ mailboxId: MBX, wrapped, kekVersion: "keys:v1" }),
      ).rejects.toBeInstanceOf(KeyServiceError);
    }
  });

  it("maps network failures and bad tokens to content-free errors", async () => {
    const { w } = service(() => {
      throw Object.assign(new Error("boom"), { name: "TimeoutError" });
    });
    await expect(w.generate({ mailboxId: MBX })).rejects.toMatchObject({ code: "timeout" });
    const { w: w2 } = service(
      () => json({}),
      async () => "bad token\r\nx: y",
    );
    await expect(w2.generate({ mailboxId: MBX })).rejects.toMatchObject({
      code: "oidc_unavailable",
    });
  });

  it("validates inputs and origin", async () => {
    const { w } = service(() => json({}));
    await expect(w.unwrap({ mailboxId: "../x", wrapped, kekVersion: "keys:v1" })).rejects.toThrow();
    await expect(
      w.unwrap({ mailboxId: MBX, wrapped: randomBytes(10), kekVersion: "keys:v1" }),
    ).rejects.toThrow();
    await expect(w.unwrap({ mailboxId: MBX, wrapped, kekVersion: "local:v1" })).rejects.toThrow();
    const opts = { getOidcToken: async () => "t" };
    expect(() => new KeyServiceWrapper({ ...opts, origin: "http://edf-keys.example" })).toThrow(
      CryptoConfigError,
    );
    expect(
      () => new KeyServiceWrapper({ ...opts, origin: "https://edf-keys.example/path" }),
    ).toThrow(CryptoConfigError);
    expect(() => new KeyServiceWrapper({ ...opts, origin: "http://localhost:3002" })).not.toThrow();
  });
});
