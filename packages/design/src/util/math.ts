/**
 * Scoring primitives (DESIGN-SCORE §2.2) and small numeric helpers.
 * Every function is pure and total: NaN/Infinity inputs never propagate into credits.
 */

/** Clamp `x` into [lo, hi]; NaN maps to `lo`. */
export function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  const v = x < lo ? lo : x > hi ? hi : x;
  return v === 0 ? 0 : v; // normalise -0
}

/**
 * `ramp(x, x0, x1) = clamp((x − x0) / (x1 − x0), 0, 1)`; `x1 < x0` gives a decreasing ramp
 * (DESIGN-SCORE §2.2). A degenerate ramp (x0 = x1) is a step at x0.
 */
export function ramp(x: number, x0: number, x1: number): number {
  if (x0 === x1) return x >= x0 ? 1 : 0;
  return clamp((x - x0) / (x1 - x0), 0, 1);
}

/**
 * `band(x, a, b, c, d)`: 0 at or below a, rising to 1 at b, flat to c, falling to 0 at d
 * (DESIGN-SCORE §2.2).
 */
export function band(x: number, a: number, b: number, c: number, d: number): number {
  if (Number.isNaN(x)) return 0;
  if (x <= a) return 0;
  if (x < b) return ramp(x, a, b);
  if (x <= c) return 1;
  if (x < d) return ramp(x, d, c);
  return 0;
}

/** `count(pred) / count(items)`; null (N/A) when there are no items (DESIGN-SCORE §2.2). */
export function share(total: number, matching: number): number | null {
  if (!(total > 0)) return null;
  return clamp(matching / total, 0, 1);
}

/** Arithmetic mean of the non-null values; null when none. */
export function meanOf(values: ReadonlyArray<number | null>): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v === null || Number.isNaN(v)) continue;
    sum += v;
    n++;
  }
  return n === 0 ? null : sum / n;
}

/**
 * Weighted quantile (lower value at ties), e.g. `q = 0.75` over [font px, characters].
 * Null without positive weight.
 */
export function weightedQuantile(
  items: ReadonlyArray<readonly [value: number, weight: number]>,
  q: number,
): number | null {
  let total = 0;
  const valid: Array<readonly [number, number]> = [];
  for (const [v, w] of items) {
    if (!(w > 0) || !Number.isFinite(v)) continue;
    valid.push([v, w]);
    total += w;
  }
  if (total === 0) return null;
  valid.sort((a, b) => a[0] - b[0]);
  const target = total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (const [v, w] of valid) {
    acc += w;
    if (acc >= target) return v;
  }
  return valid[valid.length - 1]?.[0] ?? null;
}

/**
 * Weighted median: the smallest value whose cumulative weight reaches half of the total.
 * Used for every "character-weighted median" (DESIGN-SCORE §2.1). Null when total weight is 0.
 */
export function weightedMedian(
  items: ReadonlyArray<readonly [value: number, weight: number]>,
): number | null {
  let total = 0;
  const valid: Array<readonly [number, number]> = [];
  for (const [v, w] of items) {
    if (!(w > 0) || !Number.isFinite(v)) continue;
    valid.push([v, w]);
    total += w;
  }
  if (total === 0) return null;
  valid.sort((a, b) => a[0] - b[0]);
  const half = total / 2;
  let acc = 0;
  for (const [v, w] of valid) {
    acc += w;
    if (acc >= half) return v;
  }
  return valid[valid.length - 1]?.[0] ?? null;
}

/** Unweighted median of finite numbers; null for an empty list. */
export function median(values: ReadonlyArray<number>): number | null {
  return weightedMedian(values.map((v) => [v, 1] as const));
}

/** Round to `digits` decimals (half away from zero, stable for display). */
export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return (Math.sign(x) * Math.round(Math.abs(x) * f + Number.EPSILON)) / f;
}

/**
 * Largest-remainder rounding: rounds each value to `digits` decimals so that the rounded
 * values add up exactly to `roundTo(Σ values, digits)`. Used so displayed pillar points add
 * up to the displayed raw score (DESIGN-SCORE §3, §7).
 */
export function roundPreservingSum(values: ReadonlyArray<number>, digits: number): number[] {
  const f = 10 ** digits;
  const target = Math.round(values.reduce((a, b) => a + b, 0) * f + Number.EPSILON);
  const floors = values.map((v) => Math.floor(v * f + 1e-9));
  let remainder = target - floors.reduce((a, b) => a + b, 0);
  const order = values
    .map((v, i) => ({ i, frac: v * f - Math.floor(v * f + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = floors.slice();
  for (let k = 0; remainder > 0 && k < order.length; k++, remainder--) {
    const idx = order[k]!.i;
    out[idx] = (out[idx] ?? 0) + 1;
  }
  for (let k = order.length - 1; remainder < 0 && k >= 0; k--, remainder++) {
    const idx = order[k]!.i;
    out[idx] = (out[idx] ?? 0) - 1;
  }
  return out.map((v) => v / f);
}

/**
 * Round `points` to `digits` decimals so they add up to the rounded total, never exceeding the
 * matching (already rounded) `caps` — displayed pillar points stay within their maxima.
 */
export function roundWithinCaps(
  points: ReadonlyArray<number>,
  caps: ReadonlyArray<number>,
  digits: number,
): number[] {
  const f = 10 ** digits;
  const target = Math.round(points.reduce((a, b) => a + b, 0) * f + Number.EPSILON);
  const capU = caps.map((c) => Math.round(c * f));
  const out = points.map((p, i) => Math.min(capU[i] ?? 0, Math.floor(p * f + 1e-9)));
  let remainder = target - out.reduce((a, b) => a + b, 0);
  const order = points
    .map((p, i) => ({ i, frac: p * f - Math.floor(p * f + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let pass = 0; remainder > 0 && pass < 3; pass++) {
    for (const { i } of order) {
      if (remainder <= 0) break;
      if ((out[i] ?? 0) < (capU[i] ?? 0)) {
        out[i] = (out[i] ?? 0) + 1;
        remainder--;
      }
    }
  }
  return out.map((v) => v / f);
}

/** A finite number or the fallback. */
export function finiteOr(x: number | null | undefined, fallback: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}
