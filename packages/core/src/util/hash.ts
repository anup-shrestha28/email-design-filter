/**
 * Fast non-cryptographic 64-bit hashing for simhash shingles: two independently seeded FNV-1a
 * passes, each finished with the murmur3 fmix32 avalanche, give the high and low words.
 */

function fnv1a32(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Returns [high32, low32] of a 64-bit hash of `s`. */
export function hash64(s: string): [number, number] {
  return [fmix32(fnv1a32(s, 0x811c9dc5)), fmix32(fnv1a32(s, 0x2f6b3e1d) ^ 0x9e3779b9)];
}

/**
 * 64-bit simhash over a set of features (each weight 1), as a signed decimal string so it fits
 * a PostgreSQL bigint. An empty feature set hashes to "0".
 */
export function simhash64(features: Iterable<string>): string {
  const acc = new Int32Array(64);
  let n = 0;
  for (const f of features) {
    n++;
    const [hi, lo] = hash64(f);
    for (let b = 0; b < 32; b++) {
      acc[b] = (acc[b] ?? 0) + (((lo >>> b) & 1) === 1 ? 1 : -1);
      acc[b + 32] = (acc[b + 32] ?? 0) + (((hi >>> b) & 1) === 1 ? 1 : -1);
    }
  }
  if (n === 0) return "0";
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if ((acc[b] ?? 0) > 0) lo |= 1 << b;
    if ((acc[b + 32] ?? 0) > 0) hi |= 1 << b;
  }
  const u = (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
  return BigInt.asIntN(64, u).toString();
}

/** Hamming distance between two signed-decimal simhash strings. */
export function simhashDistance(a: string, b: string): number {
  let x = BigInt.asUintN(64, BigInt(a) ^ BigInt(b));
  let d = 0;
  while (x > 0n) {
    x &= x - 1n;
    d++;
  }
  return d;
}
