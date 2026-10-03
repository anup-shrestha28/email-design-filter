/**
 * AI review output (DESIGN-SCORE §6 "Output"): per criterion `{level 1–5 | null, evidence
 * ≤ 200 chars, region}` plus flags, validated with Zod.
 *
 * Structured outputs accept only a JSON Schema subset: no numeric or string-length
 * constraints, and `additionalProperties: false` on every object. So levels are an enum of
 * literals (the constraint survives), `evidence` length is enforced client-side by
 * `parseReviewOutput` (which strips and truncates), and the API schema is sanitized.
 */
import { z } from "zod";
import type { AiCheckId, AiCriterion, AiReview } from "../types";
import { stripEvidence } from "./guards";

export const AI_MODEL = "claude-opus-5";

export const AI_REGIONS = ["top", "middle", "bottom", "mobile_top"] as const;

const level = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.null(),
]);

const criterionOutput = z
  .object({
    level,
    evidence: z.string().describe("≤ 200 characters: the visible elements behind the level."),
    region: z.enum(AI_REGIONS),
  })
  .strict();

/** What the model must return (field order = the order the rubric asks for). */
export const aiReviewOutputSchema = z
  .object({
    H7: criterionOutput.describe("Visual hierarchy clarity"),
    L8: criterionOutput.describe("Visual polish & consistency"),
    I6: criterionOutput.describe(
      "Imagery quality & relevance (level null when there are no content images)",
    ),
    C4: criterionOutput.describe("Copy clarity"),
    flags: z
      .object({ suspected_prompt_injection: z.boolean(), render_problem: z.boolean() })
      .strict(),
  })
  .strict();
export type AiReviewOutput = z.infer<typeof aiReviewOutputSchema>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const UNSUPPORTED_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "$schema",
]);

/** Remove keywords structured outputs rejects and force `additionalProperties: false`. */
export function sanitizeJsonSchema(node: JsonValue): JsonValue {
  if (Array.isArray(node)) return node.map(sanitizeJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const out: { [k: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(node)) {
    if (UNSUPPORTED_KEYS.has(k)) continue;
    out[k] = sanitizeJsonSchema(v);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** JSON Schema for `output_config.format` (derived from the Zod schema, then sanitized). */
export const AI_OUTPUT_JSON_SCHEMA = sanitizeJsonSchema(
  z.toJSONSchema(aiReviewOutputSchema) as JsonValue,
) as {
  [k: string]: JsonValue;
};

/** `output_config` for the review request (FREE-TIER.md §6.2: effort low, schema enforced). */
export const AI_OUTPUT_CONFIG = {
  effort: "low",
  format: { type: "json_schema", schema: AI_OUTPUT_JSON_SCHEMA },
} as const;

/** `max_tokens` for the visual review (FREE-TIER.md §6.2). */
export const AI_MAX_TOKENS = 2000;

const lenientCriterion = z.object({
  level,
  evidence: z.string().max(20_000),
  region: z.enum(AI_REGIONS),
});
const lenientOutput = z.object({
  H7: lenientCriterion,
  L8: lenientCriterion,
  I6: lenientCriterion,
  C4: lenientCriterion,
  flags: z.object({ suspected_prompt_injection: z.boolean(), render_problem: z.boolean() }),
});

/**
 * Validate the model's JSON and sanitize evidence (URLs, e-mail addresses and digit runs ≥ 4
 * removed; ≤ 200 chars). Returns null when the output doesn't match the schema.
 */
export function parseReviewOutput(raw: unknown): AiReviewOutput | null {
  const parsed = lenientOutput.safeParse(raw);
  if (!parsed.success) return null;
  const clean = (c: z.infer<typeof lenientCriterion>) => ({
    level: c.level,
    evidence: stripEvidence(c.evidence),
    region: c.region,
  });
  const out = {
    H7: clean(parsed.data.H7),
    L8: clean(parsed.data.L8),
    I6: clean(parsed.data.I6),
    C4: clean(parsed.data.C4),
    flags: parsed.data.flags,
  };
  return aiReviewOutputSchema.parse(out);
}

/** Assemble the stored `AiReview` from a parsed output. */
export function toAiReview(
  output: AiReviewOutput | null,
  meta: {
    reviewedAt: string;
    source: AiReview["source"];
    injectionPatternHit: boolean;
    refused: boolean;
    model?: string;
  },
): AiReview {
  const criteria: Partial<Record<AiCheckId, AiCriterion>> = {};
  if (output) {
    for (const id of ["H7", "L8", "I6", "C4"] as const) criteria[id] = { ...output[id] };
  }
  return {
    criteria,
    flags: output?.flags ?? { suspected_prompt_injection: false, render_problem: false },
    injectionPatternHit: meta.injectionPatternHit,
    model: meta.model ?? AI_MODEL,
    reviewedAt: meta.reviewedAt,
    source: meta.source,
    refused: meta.refused,
  };
}
