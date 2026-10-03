/**
 * The file protocol between the orchestrator (SandboxRenderer, in edf-app) and `render.js` in
 * the VM (FREE-TIER.md §5.1 steps 4–5). One JSON file per job in, one per result out.
 * Everything read back from the VM is untrusted: sizes are capped, JSON is validated with Zod,
 * features with `renderFeaturesSchema`, and AI tiles are checked by magic bytes and header
 * dimensions only — never decoded.
 */
import { z } from "zod";
import type { RenderJob, RenderOutcome } from "@edf/design";
import { renderFeaturesSchema } from "@edf/design/render-kit";
import { RENDER_STATUS } from "../status";

/** App directory inside the snapshot (bundle + pinned node_modules). */
export const VM_APP_DIR = "/vercel/sandbox/edf";
export const VM_JOB_DIR = `${VM_APP_DIR}/jobs`;
export const VM_OUT_DIR = `${VM_APP_DIR}/out`;
export const VM_BUNDLE_PATH = `${VM_APP_DIR}/render.js`;

/** Caps on what we accept back (FREE-TIER.md §5.1 step 5). */
export const MAX_RESULT_BYTES = 6 * 1024 * 1024;
const MAX_TILE_BYTES = 1_000_000;

export interface VmJobFile {
  v: 1;
  job: RenderJob;
  /** Absolute epoch ms by which the VM must have finished all jobs. */
  deadlineAt: number;
}

export interface VmResultFile {
  v: 1;
  id: string;
  ok: boolean;
  error: string | null;
  features: unknown;
  aiTiles: { desktop: string[]; mobile: string | null } | null;
  renderMs: number;
  chromiumVersion: string | null;
}

export function jobFileName(i: number): string {
  return `${String(i).padStart(4, "0")}.json`;
}

/** Serialize an outcome inside the VM (tiles as base64). */
export function toResultFile(o: RenderOutcome): VmResultFile {
  return {
    v: 1,
    id: o.id,
    ok: o.ok,
    error: o.error,
    features: o.features,
    aiTiles: o.aiTiles
      ? {
          desktop: o.aiTiles.desktop.map((t) => Buffer.from(t).toString("base64")),
          mobile: o.aiTiles.mobile ? Buffer.from(o.aiTiles.mobile).toString("base64") : null,
        }
      : null,
    renderMs: o.renderMs,
    chromiumVersion: o.chromiumVersion,
  };
}

const resultShape = z.object({
  v: z.literal(1),
  id: z.string().max(200),
  ok: z.boolean(),
  error: z.enum(RENDER_STATUS).nullable(),
  features: z.unknown(),
  aiTiles: z
    .object({
      desktop: z.array(z.string().max(Math.ceil((MAX_TILE_BYTES * 4) / 3) + 4)).max(3),
      mobile: z
        .string()
        .max(Math.ceil((MAX_TILE_BYTES * 4) / 3) + 4)
        .nullable(),
    })
    .nullable(),
  renderMs: z.number().int().min(0).max(3_600_000),
  chromiumVersion: z.string().max(80).nullable(),
});

/** Image type and dimensions from the header only (PNG IHDR, WebP VP8/VP8L/VP8X). */
export function imageHeader(
  b: Uint8Array,
): { type: "png" | "webp"; width: number; height: number } | null {
  if (
    b.length >= 24 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[12] === 0x49 &&
    b[13] === 0x48
  ) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { type: "png", width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  const riff =
    b.length >= 30 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50;
  if (!riff) return null;
  const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
  if (chunk === "VP8X")
    return {
      type: "webp",
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return {
      type: "webp",
      width: (b[26]! | (b[27]! << 8)) & 0x3fff,
      height: (b[28]! | (b[29]! << 8)) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { type: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function tile(b64: string, maxW: number, maxH: number): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.length === 0 || bytes.length > MAX_TILE_BYTES) return null;
  const h = imageHeader(bytes);
  if (!h || h.width < 1 || h.height < 1 || h.width > maxW || h.height > maxH) return null;
  return bytes;
}

/**
 * Validate one result file read back from the VM (untrusted). Returns a safe outcome; any
 * violation turns into a fixed error code for that email.
 */
export function parseResultFile(raw: Uint8Array | null, job: RenderJob): RenderOutcome {
  const bad = (error: RenderOutcome["error"]): RenderOutcome => ({
    id: job.id,
    ok: false,
    error,
    features: null,
    aiTiles: null,
    renderMs: 0,
    chromiumVersion: null,
  });
  if (!raw || raw.length === 0) return bad("sandbox_error");
  if (raw.length > MAX_RESULT_BYTES) return bad("invalid_features");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    return bad("invalid_features");
  }
  const shape = resultShape.safeParse(json);
  if (!shape.success || shape.data.id !== job.id) return bad("invalid_features");
  const r = shape.data;
  if (!r.ok)
    return {
      ...bad(r.error ?? "sandbox_error"),
      renderMs: r.renderMs,
      chromiumVersion: r.chromiumVersion,
    };
  const features = renderFeaturesSchema.safeParse(r.features);
  if (!features.success) return bad("invalid_features");
  let aiTiles: RenderOutcome["aiTiles"] = null;
  if (r.aiTiles && job.wantAiTiles) {
    const desktop = r.aiTiles.desktop
      .map((t) => tile(t, 600, 750))
      .filter((t): t is Uint8Array => t !== null);
    const mobile = r.aiTiles.mobile ? tile(r.aiTiles.mobile, 375, 667) : null;
    aiTiles = desktop.length > 0 || mobile ? { desktop, mobile } : null;
  }
  return {
    id: job.id,
    ok: true,
    error: null,
    features: features.data,
    aiTiles,
    renderMs: r.renderMs,
    chromiumVersion: r.chromiumVersion,
  };
}
