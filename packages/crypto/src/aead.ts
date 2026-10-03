/**
 * AES-256-GCM envelopes (DESIGN.md §4.4; FREE-TIER.md §4.2, §9.2).
 *
 * v1 (`seal`):            0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16)
 * v2 (`sealWithKeyring`): 0x02 ‖ kidLen(1) ‖ kid ‖ nonce(12) ‖ ciphertext ‖ tag(16)
 *
 * The GCM additional data is `header ‖ encodeAad(parts)`, where `header` is every envelope byte
 * before the nonce (version, and for v2 the kid). Binding the header is defense in depth
 * (DECISIONS.md D-C1): a version or kid swap can never be reinterpreted under another format.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { isWellFormedString } from "./encoding";
import { CryptoError } from "./errors";
import { KID_RE, activeKey, keyFor, type Keyring } from "./keyring";

const V1 = 0x01;
const V2 = 0x02;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const MAX_AAD_PART_BYTES = 1 << 16;

/** Length-prefixed AAD: for each part, 4-byte big-endian UTF-8 length ‖ bytes. */
export function encodeAad(parts: readonly string[]): Buffer {
  if (!Array.isArray(parts)) throw new CryptoError("bad_input");
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (typeof part !== "string" || !isWellFormedString(part)) throw new CryptoError("bad_input");
    const bytes = Buffer.from(part, "utf8");
    if (bytes.length > MAX_AAD_PART_BYTES) throw new CryptoError("bad_input");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

function asKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_LEN)
    throw new CryptoError("bad_input");
  return Buffer.from(key.buffer, key.byteOffset, key.byteLength);
}

function asPlaintext(p: Uint8Array | string): Buffer {
  if (typeof p === "string") {
    if (!isWellFormedString(p)) throw new CryptoError("bad_input");
    return Buffer.from(p, "utf8");
  }
  if (!(p instanceof Uint8Array)) throw new CryptoError("bad_input");
  return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
}

function aadFor(header: Buffer, parts: readonly string[]): Buffer {
  // Every use in this system binds at least one context value; an empty AAD is a caller bug.
  if (!Array.isArray(parts) || parts.length === 0) throw new CryptoError("bad_input");
  return Buffer.concat([header, encodeAad(parts)]);
}

function gcmSeal(key: Buffer, header: Buffer, plaintext: Buffer, parts: readonly string[]): Buffer {
  const aad = aadFor(header, parts);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, nonce, ct, cipher.getAuthTag()]);
}

function gcmOpen(key: Buffer, header: Buffer, body: Buffer, parts: readonly string[]): Buffer {
  if (body.length < NONCE_LEN + TAG_LEN) throw new CryptoError("decrypt_failed");
  const aad = aadFor(header, parts);
  const nonce = body.subarray(0, NONCE_LEN);
  const tag = body.subarray(body.length - TAG_LEN);
  const ct = body.subarray(NONCE_LEN, body.length - TAG_LEN);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CryptoError("decrypt_failed");
  }
}

function asSealed(sealed: Uint8Array): Buffer {
  if (!(sealed instanceof Uint8Array)) throw new CryptoError("decrypt_failed");
  return Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
}

/** `0x01 ‖ nonce(12) ‖ ciphertext ‖ tag(16)` with a random 96-bit nonce. */
export function seal(
  key: Uint8Array,
  plaintext: Uint8Array | string,
  aad: readonly string[],
): Buffer {
  return gcmSeal(asKey(key), Buffer.from([V1]), asPlaintext(plaintext), aad);
}

/** Inverse of seal(); throws on any tampering, wrong key or wrong AAD. */
export function open(key: Uint8Array, sealed: Uint8Array, aad: readonly string[]): Buffer {
  const k = asKey(key);
  const buf = asSealed(sealed);
  if (buf.length < 1 + NONCE_LEN + TAG_LEN || buf[0] !== V1)
    throw new CryptoError("decrypt_failed");
  return gcmOpen(k, buf.subarray(0, 1), buf.subarray(1), aad);
}

/**
 * Keyring seal: `0x02 ‖ kidLen(1) ‖ kid ‖ nonce(12) ‖ ciphertext ‖ tag(16)`, sealed with the
 * active key. Used for access tokens (`ACCESS_TOKEN_KEYS`, AAD [mailbox_id, user_id, 'access'])
 * and the OAuth state cookie (`STATE_KEYS`).
 */
export function sealWithKeyring(
  ring: Keyring,
  plaintext: Uint8Array | string,
  aad: readonly string[],
): Buffer {
  const kid = Buffer.from(ring.active, "ascii");
  if (!KID_RE.test(ring.active) || kid.length > 255) throw new CryptoError("bad_input");
  const header = Buffer.concat([Buffer.from([V2, kid.length]), kid]);
  return gcmSeal(activeKey(ring), header, asPlaintext(plaintext), aad);
}

/** Inverse of sealWithKeyring(); any kid in the ring opens. Throws on any failure. */
export function openWithKeyring(ring: Keyring, sealed: Uint8Array, aad: readonly string[]): Buffer {
  const buf = asSealed(sealed);
  if (buf.length < 2 || buf[0] !== V2) throw new CryptoError("decrypt_failed");
  const kidLen = buf[1] as number;
  if (kidLen === 0 || buf.length < 2 + kidLen + NONCE_LEN + TAG_LEN)
    throw new CryptoError("decrypt_failed");
  const kid = buf.subarray(2, 2 + kidLen).toString("latin1");
  const key = keyFor(ring, kid);
  if (key === null) throw new CryptoError("decrypt_failed");
  return gcmOpen(key, buf.subarray(0, 2 + kidLen), buf.subarray(2 + kidLen), aad);
}

/** Kid of a v2 envelope without opening it (null if malformed); used for rotation metrics. */
export function keyringKidOf(sealed: Uint8Array): string | null {
  if (!(sealed instanceof Uint8Array) || sealed.length < 2 || sealed[0] !== V2) return null;
  const kidLen = sealed[1] as number;
  if (kidLen === 0 || sealed.length < 2 + kidLen + NONCE_LEN + TAG_LEN) return null;
  const kid = Buffer.from(sealed.buffer, sealed.byteOffset + 2, kidLen).toString("latin1");
  return KID_RE.test(kid) ? kid : null;
}
