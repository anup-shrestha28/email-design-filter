/**
 * Test crypto: uses the real @edf/crypto AEAD when it's implemented, otherwise a tiny AES-256-GCM
 * helper with the same formats. `FakeKeyWrapper` wraps DEKs with a local KEK and counts calls.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as real from "@edf/crypto";
import type { Keyring, KeyWrapper, UnwrapResult, WrapContext, WrappedKey } from "@edf/crypto";
import type { TokenAead } from "../src/tokens";

function encodeAad(parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.flatMap((p) => {
      const b = Buffer.from(p, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32BE(b.length);
      return [len, b];
    }),
  );
}

function gcmSeal(
  key: Uint8Array,
  pt: Uint8Array | string,
  aad: readonly string[],
  prefix: Buffer,
): Buffer {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(encodeAad(aad));
  const ct = Buffer.concat([
    c.update(typeof pt === "string" ? Buffer.from(pt, "utf8") : pt),
    c.final(),
  ]);
  return Buffer.concat([prefix, nonce, ct, c.getAuthTag()]);
}

function gcmOpen(key: Uint8Array, body: Buffer, aad: readonly string[]): Buffer {
  const nonce = body.subarray(0, 12);
  const tag = body.subarray(body.length - 16);
  const ct = body.subarray(12, body.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(encodeAad(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export const testAead: TokenAead = {
  seal: (key, pt, aad) => gcmSeal(key, pt, aad, Buffer.from([1])),
  open: (key, sealed, aad) => {
    const b = Buffer.from(sealed);
    if (b[0] !== 1) throw new Error("bad version");
    return gcmOpen(key, b.subarray(1), aad);
  },
  sealWithKeyring: (ring, pt, aad) => {
    const key = ring.keys.get(ring.active);
    if (!key) throw new Error("no active key");
    const kid = Buffer.from(ring.active, "utf8");
    return gcmSeal(key, pt, aad, Buffer.concat([Buffer.from([2, kid.length]), kid]));
  },
  openWithKeyring: (ring, sealed, aad) => {
    const b = Buffer.from(sealed);
    if (b[0] !== 2) throw new Error("bad version");
    const kidLen = b[1] ?? 0;
    const kid = b.subarray(2, 2 + kidLen).toString("utf8");
    const key = ring.keys.get(kid);
    if (!key) throw new Error("unknown kid");
    return gcmOpen(key, b.subarray(2 + kidLen), aad);
  },
};

function realAeadWorks(): boolean {
  try {
    const key = randomBytes(32);
    const sealed = real.seal(key, "probe", ["a"]);
    const ring: Keyring = { active: "v1", keys: new Map([["v1", key]]) };
    const s2 = real.sealWithKeyring(ring, "probe", ["a"]);
    return (
      real.open(key, sealed, ["a"]).toString() === "probe" &&
      real.openWithKeyring(ring, s2, ["a"]).toString() === "probe"
    );
  } catch {
    return false;
  }
}

/** The AEAD the tests use: the real one if it works, else the local helper. */
export const aead: TokenAead = realAeadWorks()
  ? {
      seal: real.seal,
      open: real.open,
      sealWithKeyring: real.sealWithKeyring,
      openWithKeyring: real.openWithKeyring,
    }
  : testAead;

export function makeRing(active = "v1"): Keyring {
  return { active, keys: new Map([[active, randomBytes(32)]]) };
}

/** A KeyWrapper that wraps DEKs with an in-memory KEK and records every call. */
export class FakeKeyWrapper implements KeyWrapper {
  readonly kind = "local" as const;
  generateCalls = 0;
  unwrapCalls = 0;
  private readonly keks = new Map<string, Buffer>();
  /** When set, unwrap returns a re-wrapped key under this version (lazy re-wrap). */
  activeVersion: string;

  constructor(version = "local:v1") {
    this.activeVersion = version;
    this.keks.set(version, randomBytes(32));
  }

  rotate(version: string): void {
    this.keks.set(version, randomBytes(32));
    this.activeVersion = version;
  }

  private wrap(dek: Buffer, mailboxId: string, version: string): WrappedKey {
    const kek = this.keks.get(version);
    if (!kek) throw new Error("unknown kek");
    return {
      wrapped: gcmSeal(kek, dek, [mailboxId, version], Buffer.alloc(0)),
      kekVersion: version,
    };
  }

  async generate(ctx: WrapContext): Promise<{ dek: Buffer } & WrappedKey> {
    this.generateCalls++;
    const dek = randomBytes(32);
    return { dek: Buffer.from(dek), ...this.wrap(dek, ctx.mailboxId, this.activeVersion) };
  }

  async unwrap(ctx: WrapContext & WrappedKey): Promise<UnwrapResult> {
    this.unwrapCalls++;
    const kek = this.keks.get(ctx.kekVersion);
    if (!kek) throw new Error("unknown kek");
    const dek = gcmOpen(kek, Buffer.from(ctx.wrapped), [ctx.mailboxId, ctx.kekVersion]);
    const rewrapped =
      ctx.kekVersion !== this.activeVersion
        ? this.wrap(dek, ctx.mailboxId, this.activeVersion)
        : null;
    return { dek, rewrapped };
  }
}
