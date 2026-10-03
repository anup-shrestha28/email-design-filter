import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeHeaders,
  buildTrustBadge,
  classifyAutomated,
  classifyType,
  computeImportance,
  detectSecuritySensitive,
  extractContent,
  parseMime,
} from "../src/index";
import type {
  AutomatedVerdict,
  ContentExtract,
  HeaderFacts,
  ImportanceResult,
  ParsedEmail,
  SecurityVerdict,
  SenderPrior,
  TrustBadge,
  TypeVerdict,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "../../../fixtures/emails");

export interface FixtureInput {
  labelIds: string[];
  receivedAt: string;
  userAddresses: string[];
  priorContact: boolean | null;
  senderTemplateRepeats: boolean;
}

export interface PipelineResult {
  parsed: ParsedEmail;
  headers: HeaderFacts;
  content: ContentExtract;
  security: SecurityVerdict;
  automated: AutomatedVerdict;
  type: TypeVerdict;
  importance: ImportanceResult;
  trust: TrustBadge;
}

/** Runs the full ingest core the way the pipeline will (DESIGN.md §5.5 steps 2–4). */
export async function runPipeline(
  raw: Uint8Array | string,
  input: FixtureInput,
  prior: SenderPrior | null = null,
): Promise<PipelineResult> {
  const receivedAt = new Date(input.receivedAt);
  const parsed = await parseMime(raw);
  const headers = analyzeHeaders(parsed, { userAddresses: input.userAddresses });
  const content = extractContent(parsed, {
    receivedAt,
    userAddresses: input.userAddresses,
    fromDomain: headers.fromDomain,
  });
  const security = detectSecuritySensitive({ parsed, content, headers });
  const automated = classifyAutomated({
    parsed,
    headers,
    content,
    labelIds: input.labelIds,
    priorContact: input.priorContact,
    senderTemplateRepeats: input.senderTemplateRepeats,
    security,
  });
  const type = classifyType({
    parsed,
    headers,
    content,
    labelIds: input.labelIds,
    security,
    prior,
    templateClassification: null,
  });
  const importance = computeImportance({
    primaryType: type.primaryType,
    subtype: type.subtype,
    typeSource: type.typeSource,
    securitySensitive: security.securitySensitive,
    suspicious: headers.suspicious,
    authResult: headers.authResult,
    labelIds: input.labelIds,
    receivedAt,
    now: receivedAt,
    deals: content.deals,
    deadlineAt: content.deadlineAt,
    prior,
  });
  const trust = buildTrustBadge({
    headers,
    content,
    isSubscription: automated.isSubscription,
    primaryType: type.primaryType,
    visibleUnsubscribe: null,
  });
  return { parsed, headers, content, security, automated, type, importance, trust };
}

export interface FixtureCase {
  name: string;
  raw: Buffer;
  input: FixtureInput;
  expected: Record<string, unknown>;
  description: string;
}

export function loadFixtures(): FixtureCase[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -4);
      const spec = JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.expected.json`), "utf8")) as {
        description: string;
        input: FixtureInput;
        expected: Record<string, unknown>;
      };
      return {
        name,
        raw: readFileSync(join(FIXTURE_DIR, f)),
        input: spec.input,
        expected: spec.expected,
        description: spec.description,
      };
    });
}

export function readFixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, `${name}.eml`));
}

// ───────────────────────── synthetic builders ─────────────────────────

export interface EmlSpec {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  headers?: string[];
  html?: string;
  text?: string;
}

/** Builds a small RFC 822 message (multipart/alternative when both parts are given). */
export function buildEml(spec: EmlSpec): string {
  const head = [
    `From: ${spec.from ?? "Acme <news@acme.example>"}`,
    `To: ${spec.to ?? "owner@example.com"}`,
    `Subject: ${spec.subject ?? "Hello"}`,
    `Date: ${spec.date ?? "Fri, 25 Sep 2026 12:00:00 +0000"}`,
    "Message-ID: <synthetic@acme.example>",
    ...(spec.headers ?? []),
    "MIME-Version: 1.0",
  ];
  if (spec.html !== undefined && spec.text !== undefined) {
    return [
      ...head,
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      spec.text,
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      spec.html,
      "--b--",
      "",
    ].join("\r\n");
  }
  if (spec.html !== undefined)
    return [...head, "Content-Type: text/html; charset=utf-8", "", spec.html, ""].join("\r\n");
  return [...head, "Content-Type: text/plain; charset=utf-8", "", spec.text ?? "", ""].join("\r\n");
}

export const RECEIVED = new Date("2026-09-25T12:00:05Z");

/** parse + headers + content for a synthetic message. */
export async function analyze(spec: EmlSpec, labelIds: string[] = ["INBOX"]) {
  const parsed = await parseMime(buildEml(spec));
  const headers = analyzeHeaders(parsed, { userAddresses: ["owner@example.com"] });
  const content = extractContent(parsed, {
    receivedAt: RECEIVED,
    userAddresses: ["owner@example.com"],
    fromDomain: headers.fromDomain,
  });
  const security = detectSecuritySensitive({ parsed, content, headers });
  return { parsed, headers, content, security, labelIds };
}

/** classifyType for a synthetic message. */
export async function typeOf(
  spec: EmlSpec,
  labelIds: string[] = ["INBOX"],
  prior: SenderPrior | null = null,
) {
  const a = await analyze(spec, labelIds);
  return classifyType({ ...a, prior, templateClassification: null });
}

export function fakeHeaders(overrides: Partial<HeaderFacts> = {}): HeaderFacts {
  return {
    listUnsubscribe: null,
    oneClick: false,
    listId: null,
    feedbackId: null,
    precedence: null,
    autoSubmitted: null,
    auth: {
      found: true,
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      arc: "none",
      dkimPassDomains: ["acme.example"],
      dmarcHeaderFrom: "acme.example",
      dmarcPolicy: "reject",
      spfMailFromDomain: "acme.example",
    },
    authResult: "pass",
    suspicious: false,
    espPlatform: null,
    fromDomain: "acme.example",
    isNoReply: false,
    deliveredByBcc: false,
    isFreemailSender: false,
    fromSelf: false,
    ...overrides,
  };
}

export function fakeContent(overrides: Partial<ContentExtract> = {}): ContentExtract {
  return {
    visibleText: "",
    preheader: null,
    wordCount: 0,
    language: null,
    hasUnsubscribeLink: false,
    linkCount: 0,
    ctaLabels: [],
    imageCount: 0,
    tracking: {
      pixelCount: 0,
      pixelHosts: [],
      clickTrackerHosts: [],
      utmCampaign: null,
      utmMediumEmail: false,
    },
    schemaOrg: [],
    deals: [],
    deadlineAt: null,
    postalAddress: false,
    receivingStatement: false,
    simhash: "0",
    ...overrides,
  };
}

export function fakeParsed(overrides: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    headers: [],
    messageId: null,
    subject: "Hello",
    from: { address: "news@acme.example", name: "Acme" },
    replyTo: [],
    to: [{ address: "owner@example.com", name: null }],
    cc: [],
    date: null,
    html: null,
    htmlBytes: 0,
    text: null,
    hasCalendar: false,
    hasAmp: false,
    attachments: [],
    inline: [],
    ...overrides,
  };
}
