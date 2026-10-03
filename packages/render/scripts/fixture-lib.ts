/**
 * Development helpers shared by the render-fixture CLI and the end-to-end tests: parse an
 * .eml with `@edf/core`, build the render job and score contexts, render locally and score.
 *
 * Fixture-only headers (never produced by real mail): `X-EDF-Type` (primary type, default
 * promotional) and `X-EDF-Subscription` (yes/no; default: a List-Unsubscribe header exists).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  EMAIL_TYPES,
  type EmailType,
  analyzeHeaders,
  classifyType,
  detectSecuritySensitive,
  extractContent,
  parseListUnsubscribe,
  parseMime,
  type ParsedEmail,
} from "@edf/core";
import {
  type DesignFeatures,
  type FontProfile,
  type RenderJob,
  type RenderOutcome,
  type ScoreContext,
  type ScoreResult,
  type StaticContext,
  buildDesignFeatures,
  extractStaticDesign,
  fontProfile,
  scoreEmail,
} from "@edf/design";
import type { Renderer } from "../src/renderer";

export interface LoadedFixture {
  name: string;
  parsed: ParsedEmail;
  job: RenderJob;
  staticCtx: StaticContext;
  scoreCtx: ScoreContext;
}

function header(parsed: ParsedEmail, name: string): string | null {
  return parsed.headers.find((h) => h.name === name)?.value ?? null;
}

export async function loadFixture(path: string): Promise<LoadedFixture> {
  const raw = readFileSync(path);
  const parsed = await parseMime(new Uint8Array(raw));
  if (!parsed.html) throw new Error("fixture has no text/html part");
  const lu = parseListUnsubscribe(header(parsed, "list-unsubscribe"));
  const listUnsubscribeHttps = lu?.https ?? [];
  const senderDomain = parsed.from?.address.split("@")[1] ?? null;
  const receivedAt = parsed.date ?? new Date("2026-09-25T12:00:00Z");
  const content = extractContent(parsed, {
    receivedAt,
    userAddresses: parsed.to.map((t) => t.address),
    fromDomain: senderDomain,
  });
  const typeHeader = header(parsed, "x-edf-type")?.trim() ?? null;
  let primaryType: EmailType;
  let typeConfidence = 0.9;
  if (typeHeader && (EMAIL_TYPES as readonly string[]).includes(typeHeader)) {
    primaryType = typeHeader as EmailType;
  } else {
    const headers = analyzeHeaders(parsed, { userAddresses: parsed.to.map((t) => t.address) });
    const security = detectSecuritySensitive({ parsed, content, headers });
    const verdict = classifyType({
      parsed,
      headers,
      content,
      labelIds: [],
      security,
      prior: null,
      templateClassification: null,
    });
    primaryType = verdict.primaryType;
    typeConfidence = verdict.typeConfidence;
  }
  const subHeader = header(parsed, "x-edf-subscription");
  const isSubscription = subHeader ? /^y/i.test(subHeader.trim()) : lu !== null;
  const cid: Record<string, string> = {};
  for (const part of parsed.inline) {
    if (/^image\/(?:png|gif|jpe?g|webp)$/i.test(part.mimeType)) {
      cid[part.cid] =
        `data:${part.mimeType};base64,${Buffer.from(part.content).toString("base64")}`;
    }
  }
  const language = content.language;
  const snippet =
    (content.preheader ?? content.visibleText).replace(/\s+/g, " ").trim().slice(0, 160) || null;
  const name = basename(path).replace(/\.eml$/, "");
  const job: RenderJob = {
    id: name,
    html: parsed.html,
    images: {},
    cid,
    imageLog: {},
    imagesAllowed: true,
    wantAiTiles: false,
    lite: false,
    context: { listUnsubscribeHttps, senderDomain, language },
  };
  const staticCtx: StaticContext = {
    htmlBytes: parsed.htmlBytes,
    subject: parsed.subject,
    listUnsubscribeHttps,
    senderDomain,
    language,
  };
  const scoreCtx: ScoreContext = {
    primaryType,
    isSubscription,
    typeConfidence,
    subject: parsed.subject,
    snippet,
    receivedAt,
    now: new Date(receivedAt.getTime() + 86_400_000),
    listUnsubscribeHttps,
    senderDomain,
    language,
  };
  return { name, parsed, job, staticCtx, scoreCtx };
}

export interface AnalyzedFixture {
  fixture: LoadedFixture;
  outcome: RenderOutcome | null;
  features: DesignFeatures;
  result: ScoreResult;
  profile: FontProfile;
}

/** Static extraction, optional local render, and scoring. */
export async function analyzeFixture(
  path: string,
  renderer: Renderer | null,
): Promise<AnalyzedFixture> {
  const fixture = await loadFixture(path);
  const ex = extractStaticDesign(fixture.job.html, fixture.staticCtx);
  let outcome: RenderOutcome | null = null;
  if (renderer)
    [outcome = null] = await renderer.renderBatch([fixture.job], { deadlineMs: 60_000 });
  const features = buildDesignFeatures({
    static: ex.static,
    fonts: ex.fonts,
    render: outcome?.ok ? outcome.features : null,
  });
  const result = scoreEmail(features, fixture.scoreCtx);
  const profile = fontProfile(features.fonts, {
    source: result.coverage === "render" ? "render" : "static",
  });
  return { fixture, outcome, features, result, profile };
}
