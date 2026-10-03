/**
 * Versioned symmetric keyrings from env JSON (DESIGN.md §11.9: a `kid` for every secret).
 */
import { decodeConfigBase64, isPlainObject } from "./encoding";
import { CryptoConfigError } from "./errors";

/**
 * A versioned set of 32-byte secrets parsed from env JSON, e.g. `{"v1":"<base64 32 bytes>"}`.
 * `active` is the kid used for new seals/signatures; all kids verify/open.
 */
export interface Keyring {
  active: string;
  keys: ReadonlyMap<string, Buffer>;
}

/** Key ids: short, URL-safe, and never containing the `.` token separator. */
export const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_KEYS = 32;

/**
 * Natural ordering of kids so that `v10` sorts after `v9` (DECISIONS.md D-C2): digit runs
 * compare numerically, everything else by code unit.
 */
export function compareKids(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const ta = a.match(re) ?? [];
  const tb = b.match(re) ?? [];
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    const xd = /^\d/.test(x);
    const yd = /^\d/.test(y);
    if (xd && yd) {
      const xs = x.replace(/^0+(?=\d)/, "");
      const ys = y.replace(/^0+(?=\d)/, "");
      if (xs.length !== ys.length) return xs.length - ys.length;
      if (xs !== ys) return xs < ys ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  if (ta.length !== tb.length) return ta.length - tb.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse the JSON object form shared by every keyring env var. */
export function parseKidMap(json: string, what: string): Map<string, string> {
  if (typeof json !== "string" || json.trim() === "") {
    throw new CryptoConfigError(`${what}: missing`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CryptoConfigError(`${what}: invalid JSON`);
  }
  if (!isPlainObject(parsed)) throw new CryptoConfigError(`${what}: expected a JSON object`);
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new CryptoConfigError(`${what}: no keys`);
  if (entries.length > MAX_KEYS) throw new CryptoConfigError(`${what}: too many keys`);
  const out = new Map<string, string>();
  for (const [kid, value] of entries) {
    if (!KID_RE.test(kid)) throw new CryptoConfigError(`${what}: invalid kid`);
    if (typeof value !== "string")
      throw new CryptoConfigError(`${what}: key "${kid}" is not a string`);
    out.set(kid, value);
  }
  return out;
}

/** Pick the active kid: the explicit one (must exist) or the greatest in natural order. */
export function pickActiveKid(
  kids: Iterable<string>,
  active: string | undefined,
  what: string,
): string {
  const all = [...kids];
  if (active !== undefined && active !== "") {
    if (!all.includes(active)) throw new CryptoConfigError(`${what}: active kid not present`);
    return active;
  }
  const sorted = all.sort(compareKids);
  const last = sorted[sorted.length - 1];
  if (last === undefined) throw new CryptoConfigError(`${what}: no keys`);
  return last;
}

/**
 * Parse `{"v1":"base64",…}`; `active` defaults to the greatest kid in natural order
 * (`v10` > `v9`). Throws on keys ≠ 32 bytes. Error messages never include key material.
 */
export function parseKeyring(json: string, active?: string): Keyring {
  const map = parseKidMap(json, "keyring");
  const keys = new Map<string, Buffer>();
  for (const [kid, value] of map) {
    const key = decodeConfigBase64(value);
    if (key === null || key.length !== 32) {
      throw new CryptoConfigError(`keyring: key "${kid}" must be 32 bytes of base64`);
    }
    keys.set(kid, key);
  }
  return Object.freeze({ active: pickActiveKid(keys.keys(), active, "keyring"), keys });
}

/** Look up a key by kid (null when unknown or malformed). */
export function keyFor(ring: Keyring, kid: string): Buffer | null {
  if (typeof kid !== "string" || !KID_RE.test(kid)) return null;
  return ring.keys.get(kid) ?? null;
}

/** The active key (throws if the ring is inconsistent). */
export function activeKey(ring: Keyring): Buffer {
  const key = ring.keys.get(ring.active);
  if (key === undefined || key.length !== 32)
    throw new CryptoConfigError("keyring: active key missing");
  return key;
}
