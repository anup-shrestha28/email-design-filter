/**
 * HMAC-SHA256 over canonical JSON (DESIGN.md §11.5 view URLs; FREE-TIER.md §8.4 invites).
 */
import { createHmac } from "node:crypto";
import { constantTimeEqual, fromB64urlStrict, isWellFormedString } from "./encoding";
import { CryptoError } from "./errors";
import { activeKey, keyFor, type Keyring } from "./keyring";

export type HmacPart = string | number;

const SIG_LEN = 32;

/**
 * Canonical JSON of a flat array of strings and safe integers. `JSON.stringify` is canonical for
 * this domain (no objects, no floats, no -0 distinction, no lone surrogates).
 */
export function canonicalJson(parts: readonly HmacPart[]): string {
  if (!Array.isArray(parts) || parts.length === 0) throw new CryptoError("bad_input");
  for (const p of parts) {
    if (typeof p === "string") {
      if (!isWellFormedString(p)) throw new CryptoError("bad_input");
    } else if (typeof p !== "number" || !Number.isSafeInteger(p)) {
      throw new CryptoError("bad_input");
    }
  }
  return JSON.stringify(parts);
}

function mac(key: Buffer, parts: readonly HmacPart[]): Buffer {
  return createHmac("sha256", key).update(canonicalJson(parts), "utf8").digest();
}

/** HMAC-SHA256 over canonical JSON of `parts` with the active key; returns base64url. */
export function hmacSign(ring: Keyring, parts: readonly HmacPart[]): { kid: string; sig: string } {
  return { kid: ring.active, sig: mac(activeKey(ring), parts).toString("base64url") };
}

/** Constant-time verification; false for any malformed input, unknown kid or mismatch. */
export function hmacVerify(
  ring: Keyring,
  kid: string,
  sig: string,
  parts: readonly HmacPart[],
): boolean {
  try {
    const key = keyFor(ring, kid);
    if (key === null) return false;
    const given = fromB64urlStrict(sig, SIG_LEN);
    if (given === null) return false;
    return constantTimeEqual(mac(key, parts), given);
  } catch {
    return false;
  }
}
