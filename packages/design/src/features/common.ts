/**
 * Zod building blocks for the feature schemas. Every number is bounded and every array and
 * string is capped, so features read back from the render VM can be validated as untrusted
 * input (FREE-TIER.md §5.1 step 5).
 */
import { z } from "zod";

/** Non-negative integer count, bounded. */
export const count = (max = 10_000_000) => z.number().int().min(0).max(max);
/** CSS px coordinate (can be slightly negative for off-screen boxes). */
export const coord = z.number().min(-100_000).max(1_000_000);
/** CSS px length. */
export const length = z.number().min(0).max(1_000_000);
/** Font size in CSS px. */
export const px = z.number().min(0).max(2_000);
/** A share 0..1. */
export const unit = z.number().min(0).max(1);
/** Contrast ratio 1..21 (tiny float error tolerated). */
export const ratio = z.number().min(0.99).max(21.01);
/** Short label / name. */
export const shortText = (max = 64) => z.string().max(max);
/** Compact colour `#rrggbb[aa]`. */
export const hexColor = z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/);

export const boxSchema = z.object({ x: coord, y: coord, w: length, h: length });
export type Box = z.infer<typeof boxSchema>;
