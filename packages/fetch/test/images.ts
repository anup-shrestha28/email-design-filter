/** Minimal image headers for tests (enough for sniffing; pixel data is irrelevant). */

export function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 6; // RGBA
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, iend]);
}

export function jpeg(
  width: number,
  height: number,
  opts: { app1Bytes?: number; progressive?: boolean } = {},
): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  ]);
  parts.push(app0);
  if (opts.app1Bytes) {
    const n = Math.min(opts.app1Bytes, 65533);
    const seg = Buffer.alloc(4 + n);
    seg[0] = 0xff;
    seg[1] = 0xe1;
    seg.writeUInt16BE(n + 2, 2);
    parts.push(seg);
  }
  parts.push(Buffer.from([0xff, 0xff])); // fill bytes before the next marker are legal
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = opts.progressive ? 0xc2 : 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  parts.push(sof.subarray(1)); // (the extra 0xFF above precedes this marker)
  parts.push(Buffer.from([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

export function gif(
  width: number,
  height: number,
  frame?: { left: number; top: number; w: number; h: number },
): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0x80; // global color table, 2 entries
  const gct = Buffer.alloc(6);
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x01, 0, 0, 0, 0x00]);
  const f = frame ?? { left: 0, top: 0, w: width, h: height };
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(f.left, 1);
  desc.writeUInt16LE(f.top, 3);
  desc.writeUInt16LE(f.w, 5);
  desc.writeUInt16LE(f.h, 7);
  return Buffer.concat([header, gct, gce, desc, Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
}

function riff(chunk: string, data: Buffer): Buffer {
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(12 + data.length, 4);
  head.write("WEBP", 8, "ascii");
  head.write(chunk, 12, "ascii");
  head.writeUInt32LE(data.length, 16);
  return Buffer.concat([head, data]);
}

export function webpLossy(width: number, height: number): Buffer {
  const d = Buffer.alloc(10);
  d.set([0x9d, 0x01, 0x2a], 3);
  d.writeUInt16LE(width, 6);
  d.writeUInt16LE(height, 8);
  return riff("VP8 ", d);
}

export function webpLossless(width: number, height: number): Buffer {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  d.writeUInt32LE(bits >>> 0, 1);
  return riff("VP8L", d);
}

export function webpExtended(width: number, height: number): Buffer {
  const d = Buffer.alloc(10);
  d.writeUIntLE(width - 1, 4, 3);
  d.writeUIntLE(height - 1, 7, 3);
  return riff("VP8X", d);
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
);
export const AVIF = Buffer.from([
  0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0,
]);
export const HEIC = Buffer.from([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
]);
