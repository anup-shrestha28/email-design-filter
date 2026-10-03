/**
 * Mailbox key wrapping behind the `KeyWrapper` seam (FREE-TIER.md §9.2, §12 C).
 *
 * Wrapped DEK = `seal(KEK, dek, ["edf/dek-wrap/v1", mailboxId, kekVersion])`, i.e. the v1 AEAD
 * envelope (61 bytes for a 32-byte DEK). The AAD binds mailbox_id and kek_version as §9.2
 * requires; edf-keys (apps/keys) implements the same format and a cross-test proves it.
 */
import { randomBytes } from "node:crypto";
import { open, seal } from "./aead";
import { assertDevOnly, decodeConfigBase64, isPlainObject, isProductionLikeEnv } from "./encoding";
import { CryptoConfigError, CryptoError, KeyServiceError } from "./errors";
import { KID_RE, activeKey, keyFor, type Keyring } from "./keyring";

export interface WrapContext {
  mailboxId: string;
}

export interface WrappedKey {
  wrapped: Buffer;
  /** e.g. "keys:v1" (edf-keys), "kms:1" (Cloud KMS), "local:v1" (dev only). */
  kekVersion: string;
}

export interface UnwrapResult {
  dek: Buffer;
  /** Present when the key was wrapped with a non-active KEK: store it (lazy re-wrap). */
  rewrapped: WrappedKey | null;
}

/** The seam that lets edf-keys be swapped for Cloud KMS without touching callers. */
export interface KeyWrapper {
  readonly kind: "keys" | "kms" | "local";
  /** Create a fresh random 256-bit DEK and return it with its wrapped form. */
  generate(ctx: WrapContext): Promise<{ dek: Buffer } & WrappedKey>;
  unwrap(ctx: WrapContext & WrappedKey): Promise<UnwrapResult>;
}

export const DEK_WRAP_AAD_LABEL = "edf/dek-wrap/v1";
export const DEK_LENGTH = 32;
/** 1 (version) + 12 (nonce) + 32 (DEK) + 16 (tag). */
export const WRAPPED_DEK_LENGTH = 61;
export const MAILBOX_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const KEYS_KEK_VERSION_RE = /^keys:([A-Za-z0-9_-]{1,32})$/;
const LOCAL_KEK_VERSION_RE = /^local:([A-Za-z0-9_-]{1,32})$/;
const KEY_SERVICE_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 8 * 1024;

/** AAD for wrapping a mailbox DEK. */
export function dekWrapAad(mailboxId: string, kekVersion: string): string[] {
  return [DEK_WRAP_AAD_LABEL, mailboxId, kekVersion];
}

function assertMailboxId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !MAILBOX_ID_RE.test(id)) throw new CryptoError("bad_input");
}

function assertWrapped(w: unknown): asserts w is Buffer {
  if (!(w instanceof Uint8Array) || w.byteLength !== WRAPPED_DEK_LENGTH)
    throw new CryptoError("bad_input");
}

// ───────────────────────── edf-keys client ─────────────────────────

function b64(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString("base64");
}

function decodeField(v: unknown, len: number): Buffer {
  if (typeof v !== "string") throw new KeyServiceError("bad_response");
  const buf = decodeConfigBase64(v);
  if (buf === null || buf.length !== len) throw new KeyServiceError("bad_response");
  return buf;
}

function decodeKekVersion(v: unknown): string {
  if (typeof v !== "string" || !KEYS_KEK_VERSION_RE.test(v))
    throw new KeyServiceError("bad_response");
  return v;
}

function validateOrigin(origin: unknown): string {
  if (typeof origin !== "string") throw new CryptoConfigError("KEYS_ORIGIN: missing");
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new CryptoConfigError("KEYS_ORIGIN: not a URL");
  }
  const loopback =
    u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  const allowed =
    u.protocol === "https:" || (u.protocol === "http:" && loopback && !isProductionLikeEnv());
  if (!allowed || u.origin !== origin) {
    throw new CryptoConfigError(
      "KEYS_ORIGIN: must be an https origin without path (http://localhost in dev)",
    );
  }
  return u.origin;
}

async function readCappedJson(res: Response): Promise<unknown> {
  if (res.body === null) throw new KeyServiceError("bad_response");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new KeyServiceError("bad_response");
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new KeyServiceError("bad_response");
  }
}

/**
 * Calls edf-keys `POST {origin}/unwrap` with `Authorization: Bearer <function OIDC token>`.
 * Body: `{op:"generate", mailboxId}` → `{dek, wrapped, kekVersion}` or
 * `{op:"unwrap", mailboxId, wrapped, kekVersion}` → `{dek, rewrapped?}` (base64 fields;
 * `rewrapped` is `{wrapped, kekVersion}` or null). 5 s timeout; redirects are refused (the bearer
 * token must never be forwarded); responses are size-capped and strictly validated; never logs.
 */
export class KeyServiceWrapper implements KeyWrapper {
  readonly kind = "keys" as const;
  readonly #origin: string;
  readonly #getOidcToken: () => Promise<string>;
  readonly #fetch: typeof fetch;

  constructor(opts: {
    origin: string;
    getOidcToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
  }) {
    this.#origin = validateOrigin(opts?.origin);
    if (typeof opts.getOidcToken !== "function")
      throw new CryptoConfigError("getOidcToken: missing");
    this.#getOidcToken = opts.getOidcToken;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  async #call(body: Record<string, string>): Promise<Record<string, unknown>> {
    let token: string;
    try {
      token = await this.#getOidcToken();
    } catch {
      throw new KeyServiceError("oidc_unavailable");
    }
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 8192 ||
      !/^[A-Za-z0-9._-]+$/.test(token)
    ) {
      throw new KeyServiceError("oidc_unavailable");
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#origin}/unwrap`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(KEY_SERVICE_TIMEOUT_MS),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      throw new KeyServiceError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      );
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new KeyServiceError(`http_${res.status}`);
    }
    const ct = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (ct !== "application/json") {
      await res.body?.cancel().catch(() => undefined);
      throw new KeyServiceError("bad_response");
    }
    let json: unknown;
    try {
      json = await readCappedJson(res);
    } catch (err) {
      if (err instanceof KeyServiceError) throw err;
      const name = err instanceof Error ? err.name : "";
      throw new KeyServiceError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      );
    }
    if (!isPlainObject(json)) throw new KeyServiceError("bad_response");
    return json;
  }

  async generate(ctx: WrapContext): Promise<{ dek: Buffer } & WrappedKey> {
    assertMailboxId(ctx?.mailboxId);
    const r = await this.#call({ op: "generate", mailboxId: ctx.mailboxId });
    return {
      dek: decodeField(r.dek, DEK_LENGTH),
      wrapped: decodeField(r.wrapped, WRAPPED_DEK_LENGTH),
      kekVersion: decodeKekVersion(r.kekVersion),
    };
  }

  async unwrap(ctx: WrapContext & WrappedKey): Promise<UnwrapResult> {
    assertMailboxId(ctx?.mailboxId);
    assertWrapped(ctx.wrapped);
    if (typeof ctx.kekVersion !== "string" || !KEYS_KEK_VERSION_RE.test(ctx.kekVersion)) {
      throw new CryptoError("bad_input");
    }
    const r = await this.#call({
      op: "unwrap",
      mailboxId: ctx.mailboxId,
      wrapped: b64(ctx.wrapped),
      kekVersion: ctx.kekVersion,
    });
    const dek = decodeField(r.dek, DEK_LENGTH);
    let rewrapped: WrappedKey | null = null;
    if (r.rewrapped !== undefined && r.rewrapped !== null) {
      if (!isPlainObject(r.rewrapped)) throw new KeyServiceError("bad_response");
      rewrapped = {
        wrapped: decodeField(r.rewrapped.wrapped, WRAPPED_DEK_LENGTH),
        kekVersion: decodeKekVersion(r.rewrapped.kekVersion),
      };
    }
    return { dek, rewrapped };
  }
}

// ───────────────────────── local (development only) ─────────────────────────

/** Development only ("local:v1"): wraps with a local keyring. Refuses to construct when NODE_ENV=production. */
export class LocalKeyWrapper implements KeyWrapper {
  readonly kind = "local" as const;
  readonly #ring: Keyring;

  constructor(ring: Keyring) {
    assertDevOnly("LocalKeyWrapper");
    if (!KID_RE.test(ring?.active ?? ""))
      throw new CryptoConfigError("LocalKeyWrapper: invalid keyring");
    activeKey(ring);
    this.#ring = ring;
  }

  async generate(ctx: WrapContext): Promise<{ dek: Buffer } & WrappedKey> {
    assertMailboxId(ctx?.mailboxId);
    const dek = randomBytes(DEK_LENGTH);
    const kekVersion = `local:${this.#ring.active}`;
    const wrapped = seal(activeKey(this.#ring), dek, dekWrapAad(ctx.mailboxId, kekVersion));
    return { dek, wrapped, kekVersion };
  }

  async unwrap(ctx: WrapContext & WrappedKey): Promise<UnwrapResult> {
    assertMailboxId(ctx?.mailboxId);
    assertWrapped(ctx.wrapped);
    const m = typeof ctx.kekVersion === "string" ? LOCAL_KEK_VERSION_RE.exec(ctx.kekVersion) : null;
    if (m === null) throw new CryptoError("bad_input");
    const kid = m[1] as string;
    const kek = keyFor(this.#ring, kid);
    if (kek === null) throw new CryptoError("decrypt_failed");
    const dek = open(kek, ctx.wrapped, dekWrapAad(ctx.mailboxId, ctx.kekVersion));
    if (dek.length !== DEK_LENGTH) throw new CryptoError("decrypt_failed");
    if (kid === this.#ring.active) return { dek, rewrapped: null };
    const kekVersion = `local:${this.#ring.active}`;
    const wrapped = seal(activeKey(this.#ring), dek, dekWrapAad(ctx.mailboxId, kekVersion));
    return { dek, rewrapped: { wrapped, kekVersion } };
  }
}
