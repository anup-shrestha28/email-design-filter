/**
 * UTF-8 byte accounting for the Gmail clip rule (DESIGN-SCORE §5.8 X1): sizes and offsets are
 * measured in UTF-8 bytes of the *decoded* text/html part, while parse5 reports offsets in
 * UTF-16 code units. `ByteOffsetMapper` converts between the two in O(1) amortised time.
 */

/** UTF-8 byte length of one UTF-16 code unit at `i` (surrogate pairs count 4 on the high unit). */
function unitBytes(s: string, i: number): number {
  const c = s.charCodeAt(i);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c >= 0xd800 && c <= 0xdbff) {
    const next = s.charCodeAt(i + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 3; // lone surrogate → U+FFFD (3 bytes)
  }
  if (c >= 0xdc00 && c <= 0xdfff) {
    const prev = i > 0 ? s.charCodeAt(i - 1) : 0;
    return prev >= 0xd800 && prev <= 0xdbff ? 0 : 3;
  }
  return 3;
}

/** UTF-8 byte length of a string (identical to `Buffer.byteLength(s, "utf8")`). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += unitBytes(s, i);
  return n;
}

const STRIDE = 512;

/** Maps UTF-16 code-unit offsets of one string to UTF-8 byte offsets. */
export class ByteOffsetMapper {
  private readonly checkpoints: Uint32Array;

  constructor(private readonly s: string) {
    const n = Math.floor(s.length / STRIDE) + 1;
    this.checkpoints = new Uint32Array(n + 1);
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      if (i % STRIDE === 0) this.checkpoints[i / STRIDE] = bytes;
      bytes += unitBytes(s, i);
    }
    if (s.length % STRIDE === 0) this.checkpoints[s.length / STRIDE] = bytes;
    this.total = bytes;
  }

  /** Total UTF-8 bytes of the string. */
  readonly total: number;

  /** UTF-8 byte offset of code-unit offset `offset` (clamped to the string). */
  toBytes(offset: number): number {
    const o = Math.max(0, Math.min(this.s.length, Math.floor(offset)));
    if (o === this.s.length) return this.total;
    const k = Math.floor(o / STRIDE);
    let bytes = this.checkpoints[k] ?? 0;
    for (let i = k * STRIDE; i < o; i++) bytes += unitBytes(this.s, i);
    return bytes;
  }
}
