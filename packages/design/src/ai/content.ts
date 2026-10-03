/**
 * User content for the visual review (DESIGN-SCORE §6 "Inputs"; FREE-TIER.md §6.2): images
 * first (3 desktop tiles, then the mobile first viewport), then neutral facts and the
 * email-derived strings — only ever inside delimited data blocks, with angle brackets
 * neutralised so the sender cannot close a block. No check results are ever sent (that would
 * anchor the reviewer and make the cross-check circular).
 */
import type { EmailType } from "@edf/core/types";
import { collapseWhitespace, truncate } from "../util/text";

/** Structurally compatible with the Anthropic SDK's `ImageBlockParam`. */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: "image/png" | "image/webp" | "image/jpeg"; data: string };
}

/** Structurally compatible with the Anthropic SDK's `TextBlockParam`. */
export interface TextBlock {
  type: "text";
  text: string;
}

export type ReviewContentBlock = ImageBlock | TextBlock;

export interface ReviewInput {
  /** 3 desktop tiles (top, middle, bottom) then optionally the mobile first viewport. */
  tiles: { desktop: Uint8Array[]; mobile: Uint8Array | null };
  subject: string | null;
  type: EmailType;
  /** Primary-CTA bounding box in CSS px, with the pass it was measured in, or null. */
  ctaBox: { pass: "desktop" | "mobile"; x: number; y: number; w: number; h: number } | null;
  /** Extracted visible text; at most 2,000 characters are sent. */
  visibleText: string;
}

/** Media type from magic bytes; tiles are never decoded here (FREE-TIER.md §5.1 step 5). */
export function sniffImageType(bytes: Uint8Array): ImageBlock["source"]["media_type"] | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  return null;
}

/** Neutralise angle brackets so untrusted text can't open or close a data block. */
export function neutralize(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

function imageBlock(bytes: Uint8Array): ImageBlock | null {
  const media = sniffImageType(bytes);
  if (!media || bytes.length > 3_500_000) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: media, data: Buffer.from(bytes).toString("base64") },
  };
}

/**
 * Build the review's user content: images before text; neutral facts; subject and visible
 * text in delimited, neutralised data blocks.
 */
export function buildReviewUserContent(input: ReviewInput): ReviewContentBlock[] {
  const blocks: ReviewContentBlock[] = [];
  for (const tile of input.tiles.desktop.slice(0, 3)) {
    const b = imageBlock(tile);
    if (b) blocks.push(b);
  }
  const desktopCount = blocks.length;
  if (input.tiles.mobile) {
    const b = imageBlock(input.tiles.mobile);
    if (b) blocks.push(b);
  }
  const hasMobile = blocks.length > desktopCount;
  const box = input.ctaBox
    ? `${input.ctaBox.pass} render, x=${Math.round(input.ctaBox.x)} y=${Math.round(input.ctaBox.y)} w=${Math.round(input.ctaBox.w)} h=${Math.round(input.ctaBox.h)} (CSS px)`
    : "none detected";
  const subject = neutralize(truncate(collapseWhitespace(input.subject ?? ""), 300));
  const text = neutralize(truncate(collapseWhitespace(input.visibleText), 2000));
  blocks.push({
    type: "text",
    text: [
      `Images: ${desktopCount} desktop tile${desktopCount === 1 ? "" : "s"} (top, middle, bottom)${hasMobile ? ", then the first phone screen" : "; no phone screen available"}.`,
      "",
      "<email_facts>",
      `email_type: ${input.type}`,
      `primary_cta_box: ${box}`,
      "</email_facts>",
      "",
      "<untrusted_subject>",
      subject || "(empty)",
      "</untrusted_subject>",
      "",
      "<untrusted_visible_text>",
      text || "(no visible text)",
      "</untrusted_visible_text>",
      "",
      "Review the email's design against the rubric and return the JSON object.",
    ].join("\n"),
  });
  return blocks;
}
