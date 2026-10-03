/**
 * DEVELOPMENT ONLY — typed mock design results for /dev/preview. Realistic values that respect
 * the engine's invariants: Σ pillar points = raw, Σ pillar max = 100, AI ≤ 14 points, caps ≤ 69.
 */
import type {
  CapId,
  CheckId,
  CheckResult,
  CheckSource,
  CheckStatus,
  ExplanationItem,
  FontProfile,
  PillarId,
  PillarScore,
  ScoreResult,
  ScoreSummary,
  StaticChip,
} from "@edf/design/types";
import type { EmailDetail } from "@/server/queries/types";

type Row = [CheckId, PillarId, number, CheckStatus, number | null, unknown, CheckSource?];

const LABEL: Record<PillarId, string> = {
  accessibility: "Accessibility",
  mobile: "Mobile & Responsiveness",
  typography: "Readability & Typography",
  hierarchy: "Visual Hierarchy & CTA",
  images: "Images & Media",
  layout: "Layout, Color & Consistency",
  content: "Content & Structure",
  technical: "Technical Health",
  footer: "Footer & Unsubscribe UX",
};
const NOMINAL: Record<PillarId, number> = {
  accessibility: 20,
  mobile: 15,
  typography: 15,
  hierarchy: 15,
  images: 10,
  layout: 10,
  content: 5,
  technical: 5,
  footer: 5,
};

/** Check id, pillar, nominal weight, status, credit, measured value, source. */
const BASE_ROWS: Row[] = [
  [
    "A1",
    "accessibility",
    5,
    "partial",
    0.62,
    { passShare: 0.82, worst: "#9A9A9A on #FFFFFF = 2.8:1" },
  ],
  ["A2", "accessibility", 3.5, "partial", 0.64, { withAlt: "8/11", meaningful: "5/8" }, "static"],
  ["A3", "accessibility", 2.5, "pass", 0.96, { named: "24/24", generic: 1 }, "static"],
  ["A4", "accessibility", 1, "pass", 1, 'lang="en" on wrapper', "static"],
  ["A5", "accessibility", 1, "pass", 1, "12/12 layout tables", "static"],
  ["A6", "accessibility", 1, "partial", 0.7, { markedUp: "1/1", h1: false }],
  ["A7", "accessibility", 2, "pass", 0.93, "27/29 targets ≥ 24px"],
  ["A8", "accessibility", 1, "pass", 1, "inline links underlined"],
  ["A9", "accessibility", 0.25, "pass", 1, "<title> present", "static"],
  ["A10", "accessibility", 0.25, "pass", 1, "no misuse", "static"],
  ["A11", "accessibility", 0.5, "fail", 0, "no dir attribute", "static"],
  ["A12", "accessibility", 0.5, "pass", 1, { tau: 0.97 }],
  ["A13", "accessibility", 1.5, "not_evaluated", null, "OCR is off"],
  ["M1", "mobile", 2.5, "pass", 1, { k: 1 }],
  ["M2", "mobile", 1.5, "partial", 0.6, { kNoMq: 0.85 }],
  ["M3", "mobile", 2.5, "pass", 0.98, "98% of text in columns ≥ 250px"],
  ["M4", "mobile", 2, "pass", 1, "48 × 312px"],
  ["M5", "mobile", 2.5, "partial", 0.78, { fit: 1, aspect: 1, sharp: 0.33 }],
  ["M6", "mobile", 2, "partial", 0.74, { partial: 0.81, full: 0.67 }],
  ["M7", "mobile", 2, "pass", 1, "16px gutters"],
  ["T1", "typography", 4, "pass", 1, "16px"],
  ["T2", "typography", 2, "pass", 1, "16px"],
  ["T3", "typography", 2, "pass", 1, "1.5"],
  ["T4", "typography", 2, "pass", 0.92, "71 characters per line"],
  ["T5", "typography", 1.5, "partial", 0.55, "38% of body text centred"],
  ["T6", "typography", 1.5, "pass", 0.9, { families: 2, sizes: 7 }],
  ["T7", "typography", 1, "pass", 1, "3% uppercase", "static"],
  ["T8", "typography", 1, "not_applicable", null, "fewer than 100 words", "static"],
  ["H1", "hierarchy", 1, "pass", 1, "“Shop the sale”", "static"],
  ["H2", "hierarchy", 2, "pass", 1, "bottom edge at 540px (first screen)"],
  ["H3", "hierarchy", 2.5, "pass", 0.88, { label: "5.9:1", salience: 0.8, rank: 1 }],
  ["H4", "hierarchy", 1, "pass", 1, "Shop the sale", "static"],
  ["H5", "hierarchy", 1, "partial", 0.7, "3 distinct buttons in the first two screens"],
  ["H6", "hierarchy", 1.5, "pass", 1, "ratio 2.4"],
  ["H7", "hierarchy", 6, "pass", 0.75, { level: 4 }, "ai"],
  ["I1", "images", 3, "pass", 1, "612 legible characters"],
  ["I2", "images", 2, "pass", 0.94, "headline and offer are live text"],
  ["I3", "images", 2, "pass", 1, "11/11 images load"],
  ["I4", "images", 1, "partial", 0.62, { ratio: 0.57 }],
  ["I5", "images", 0.5, "pass", 1, "1.4 MB"],
  ["I6", "images", 1.5, "pass", 0.75, { level: 4 }, "ai"],
  ["L1", "layout", 1, "pass", 1, "640px"],
  ["L2", "layout", 1, "pass", 0.9, "p55 for promotions"],
  ["L3", "layout", 1, "pass", 1, "below p90"],
  ["L4", "layout", 1, "partial", 0.6, "10 alignment anchors"],
  ["L5", "layout", 1, "pass", 1, { dominant: 4, text: 3 }],
  ["L6", "layout", 0.5, "pass", 0.8, { buttonStyles: 2 }],
  ["L7", "layout", 0.5, "pass", 1, "logo in the first 200px"],
  ["L8", "layout", 4, "pass", 0.75, { level: 4 }, "ai"],
  ["C1", "content", 0.75, "pass", 0.9, "31 characters, 6 words", "static"],
  ["C2", "content", 0.75, "pass", 0.95, "preview text 84 characters", "static"],
  ["C3", "content", 0.5, "not_applicable", null, "≤ 150 words"],
  ["C4", "content", 2.5, "pass", 0.75, { level: 4 }, "ai"],
  ["C5", "content", 0.5, "pass", 1, "4.1 screens"],
  ["X1", "technical", 2, "partial", 0.8, "94 KB decoded HTML", "static"],
  ["X2", "technical", 1.5, "pass", 0.86, { risk: 0.14 }, "static"],
  ["X3", "technical", 1, "pass", 1, "no defects, 100% https", "static"],
  ["X4", "technical", 0.5, "pass", 1, "11 KB of styles", "static"],
  ["U1", "footer", 2, "partial", 0.3, "only after the clip point", "static"],
  ["U2", "footer", 2, "fail", 0.05, { px: 10, contrast: "2.1:1" }],
  ["U3", "footer", 0.5, "fail", 0, "no preferences link", "static"],
  ["U4", "footer", 0.5, "pass", 1, "statement present", "static"],
];

const AI_IDS = new Set<CheckId>(["H7", "L8", "C4", "I6"]);
const SCORED = new Set<CheckStatus>(["pass", "partial", "fail"]);

function buildChecks(rows: Row[]): { checks: CheckResult[]; pillars: PillarScore[]; raw: number } {
  const detW = rows
    .filter(([id, , , st]) => !AI_IDS.has(id) && SCORED.has(st))
    .reduce((a, r) => a + r[2], 0);
  const aiW = rows
    .filter(([id, , , st]) => AI_IDS.has(id) && SCORED.has(st))
    .reduce((a, r) => a + r[2], 0);
  const checks = rows.map<CheckResult>(([id, pillar, w, status, s, value, source]) => {
    const scored = SCORED.has(status) && s !== null;
    const e = !scored ? 0 : AI_IDS.has(id) ? w : ((100 - aiW) * w) / detW;
    const credit = scored ? (s ?? 0) : 0;
    return {
      id,
      pillar,
      status,
      s: scored ? s : null,
      value,
      w,
      e,
      points: e * credit,
      pointsLost: scored ? e * (1 - credit) : 0,
      source: source ?? (AI_IDS.has(id) ? "ai" : "render"),
    };
  });
  const pillars = (Object.keys(NOMINAL) as PillarId[]).map<PillarScore>((p) => {
    const cs = checks.filter((c) => c.pillar === p);
    return {
      id: p,
      label: LABEL[p],
      points: cs.reduce((a, c) => a + c.points, 0),
      max: cs.reduce((a, c) => a + c.e, 0),
      nominal: NOMINAL[p],
    };
  });
  const raw = Math.round(checks.reduce((a, c) => a + c.points, 0) * 10) / 10;
  return { checks, pillars, raw };
}

const NEEDS: ExplanationItem[] = [
  {
    key: "check:U2",
    kind: "check",
    checkIds: ["U2"],
    title: "Unsubscribe link is 10px light-grey text (contrast 2.1:1)",
    measured: "10px · 2.1:1",
    target: "≥ 12px · ≥ 4.5:1",
    fix: "Set the footer links to at least 12px and a colour of #6B6B6B or darker on white.",
    source: "WCAG 2.2 SC 1.4.3",
    points: 3.1,
    ai: false,
    regions: [{ pass: "desktop", x: 250, y: 2140, w: 300, h: 26 }],
  },
  {
    key: "check:A1",
    kind: "check",
    checkIds: ["A1"],
    title: "18% of text fails WCAG AA contrast (grey #9A9A9A on white = 2.8:1)",
    measured: "82% passing",
    target: "≥ 98% passing",
    fix: "Darken secondary text to #767676 or darker, or use it only for large text.",
    source: "WCAG 2.2 SC 1.4.3",
    points: 2.2,
    ai: false,
    regions: [
      { pass: "desktop", x: 80, y: 980, w: 640, h: 96 },
      { pass: "desktop", x: 80, y: 1620, w: 640, h: 64 },
    ],
  },
  {
    key: "check:A2",
    kind: "check",
    checkIds: ["A2"],
    title: "3 of 11 images have no alt text (incl. the hero banner)",
    measured: "8 of 11",
    target: "all images",
    fix: "Add alt text that says what the hero shows, e.g. “Alder rain shell in moss green, 30% off”.",
    source: "WCAG 2.2 SC 1.1.1",
    points: 1.5,
    ai: false,
    regions: [{ pass: "desktop", x: 0, y: 120, w: 800, h: 420 }],
  },
  {
    key: "check:X1",
    kind: "check",
    checkIds: ["X1"],
    title: "HTML is 94 KB — close to Gmail's ~102 KB clipping limit",
    measured: "94 KB",
    target: "≤ 90 KB",
    fix: "Remove unused CSS and repeated inline styles; move tracking parameters out of every link.",
    source: "Litmus: Gmail clipping",
    points: 0.5,
    ai: false,
  },
  {
    key: "ai:H7",
    kind: "ai",
    checkIds: ["H7"],
    title: "Two product blocks compete with the main offer in the second screen",
    fix: "Make the secondary products smaller or move them below the main call to action.",
    points: 1.5,
    ai: true,
  },
];

const GOOD: ExplanationItem[] = [
  {
    key: "check:H2",
    kind: "check",
    checkIds: ["H2"],
    title: "Primary button “Shop the sale” is in the first screen on mobile and 48px tall",
    points: 3.3,
    ai: false,
  },
  {
    key: "check:T1",
    kind: "check",
    checkIds: ["T1", "T3"],
    title: "Body text is 16px on mobile with a measured line height of 1.5",
    points: 6.6,
    ai: false,
  },
  {
    key: "check:M1",
    kind: "check",
    checkIds: ["M1"],
    title: "Fits a 375px phone without shrinking; single-column layout",
    points: 2.7,
    ai: false,
  },
  {
    key: "check:I2",
    kind: "check",
    checkIds: ["I2"],
    title: "Headline and offer are live text — readable with images off",
    points: 2.0,
    ai: false,
  },
  {
    key: "ai:L8",
    kind: "ai",
    checkIds: ["L8"],
    title: "Consistent spacing rhythm and a cohesive palette",
    points: 3.0,
    ai: true,
  },
];

const STATIC_CHIPS: StaticChip[] = [
  { code: "near_clip", label: "Close to Gmail's clipping limit (94 KB)", severity: "medium" },
  { code: "no_alt_text", label: "3 images without alt text", severity: "medium" },
  { code: "merge_tag_subject", label: "Merge tag in subject: *|FNAME|*", severity: "high" },
];

function result(opts: {
  rows?: Row[];
  coverage?: ScoreResult["coverage"];
  aiPending?: boolean;
  caps?: CapId[];
  provisional?: boolean;
  confidence?: number;
  needs?: ExplanationItem[];
  good?: ExplanationItem[];
}): ScoreResult {
  const rows = (opts.rows ?? BASE_ROWS).map<Row>((r) =>
    opts.aiPending && AI_IDS.has(r[0])
      ? [r[0], r[1], r[2], "not_evaluated", null, "AI review pending", "ai"]
      : r,
  );
  const { checks, pillars, raw } = buildChecks(rows);
  const capLimit = Math.min(
    100,
    ...(opts.caps ?? []).map(
      (c) =>
        ({
          CAP_IMAGE_ONLY: 49,
          CAP_CONTRAST: 59,
          CAP_BROKEN_IMAGES: 59,
          CAP_MOBILE_BROKEN: 64,
          CAP_CLIPPED: 69,
          CAP_MERGE_TAG: 69,
        })[c],
    ),
  );
  const score = Math.round(Math.min(raw, capLimit));
  const confidence = opts.confidence ?? (opts.aiPending ? 0.845 : 0.915);
  return {
    scoringVersion: "2026.1",
    coverage: opts.coverage ?? "render",
    score,
    raw,
    band: score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 50 ? "needs_work" : "poor",
    caps: opts.caps ?? [],
    capped: score < Math.round(raw),
    issues: (opts.caps ?? []).includes("CAP_CONTRAST") ? ["contrast"] : [],
    confidence,
    confidenceBand: confidence >= 0.85 ? "high" : confidence >= 0.7 ? "medium" : "low",
    provisional: opts.provisional ?? false,
    aiPending: opts.aiPending ?? false,
    checks,
    pillars,
    needsImprovement: opts.needs ?? (opts.aiPending ? NEEDS.filter((n) => !n.ai) : NEEDS),
    good: opts.good ?? (opts.aiPending ? GOOD.filter((g) => !g.ai) : GOOD),
    staticChips: STATIC_CHIPS.slice(0, 2),
    info: {
      imageTextRatio: "38% image",
      links: 24,
      readingTime: "1 min",
      esp: "Klaviyo",
      amp: false,
    },
  };
}

export const RESULT_RENDER_AI = result({});
export const RESULT_AI_PENDING = result({ aiPending: true });
export const RESULT_TEMPLATE = result({ coverage: "template", confidence: 0.71 });
export const RESULT_CAPPED = result({
  caps: ["CAP_CONTRAST"],
  needs: [
    {
      key: "cap:CAP_CONTRAST",
      kind: "cap",
      checkIds: ["A1"],
      title: "46% of body text fails WCAG AA contrast (grey #A0A0A0 on white = 2.6:1)",
      measured: "54% passing",
      target: "≥ 60% to lift the cap · ≥ 98% for full credit",
      fix: "Use #6B6B6B or darker for body copy. Light grey on white is unreadable for many readers.",
      source: "WCAG 2.2 SC 1.4.3",
      points: 7.4,
      ai: false,
      regions: [{ pass: "desktop", x: 60, y: 620, w: 680, h: 540 }],
    },
    ...NEEDS.slice(0, 3),
  ],
});
export const RESULT_PROVISIONAL = result({
  coverage: "template",
  aiPending: true,
  confidence: 0.64,
  provisional: true,
  rows: BASE_ROWS.map<Row>((r) =>
    r[0] === "T5" ? [r[0], r[1], r[2], "fail", 0, "62% of body text centred"] : r,
  ),
});
export const RESULT_STATIC: ScoreResult = {
  ...result({ coverage: "static", confidence: 0.225 }),
  score: null,
  raw: null,
  band: null,
  staticChips: STATIC_CHIPS,
  needsImprovement: [],
  good: [],
};

export const SUMMARY: ScoreSummary = {
  scoringVersion: "2026.1",
  coverage: "render",
  score: 77,
  raw: 77.4,
  band: "good",
  caps: [],
  confidence: 0.915,
  pillars: RESULT_RENDER_AI.pillars.map((p) => ({ id: p.id, points: p.points * 0.95, max: p.max })),
  needsImprovement: NEEDS.slice(0, 4).map(({ key, title, points, ai }) => ({
    key,
    title,
    points,
    ai,
  })),
  good: GOOD.slice(0, 4).map(({ key, title, points, ai }) => ({ key, title, points, ai })),
  fonts: {
    families: [
      { name: "Inter", share: 0.74, role: "body", class: "web" },
      { name: "Montserrat", share: 0.23, role: "heading", class: "web" },
    ],
    gmailWeb: "Arial",
    outlookClassic: "Times New Roman",
    outlookClassicWarning: true,
  },
};

export const FONTS_RENDER: FontProfile = {
  source: "render",
  measured: true,
  families: [
    {
      name: "Inter",
      share: 0.74,
      roles: ["body", "button"],
      class: "web",
      provider: "Google Fonts",
      weights: [
        { weight: 400, synthesized: false },
        { weight: 600, synthesized: true },
      ],
      weightNote: null,
    },
    {
      name: "Montserrat",
      share: 0.23,
      roles: ["heading"],
      class: "web",
      provider: "Google Fonts",
      weights: [
        { weight: 400, synthesized: false },
        { weight: 700, synthesized: false },
      ],
      weightNote: "variable 100–900",
    },
  ],
  noFontSetShare: 0.03,
  fallbacks: ["Arial", "Helvetica"],
  declaredUnused: ["Lato"],
  clients: [
    {
      client: "gmail_web",
      label: "Gmail (web)",
      likely: "Arial",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: false,
      note: "Gmail doesn't load web fonts, so readers see the first installed backup.",
    },
    {
      client: "gmail_android",
      label: "Gmail (Android)",
      likely: "Roboto",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: false,
      note: "Arial maps to Roboto on Android.",
    },
    {
      client: "gmail_ios",
      label: "Gmail (iPhone)",
      likely: "Arial",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: false,
      note: "No web fonts in Gmail for iOS.",
    },
    {
      client: "outlook_classic",
      label: "Outlook for Windows (classic)",
      likely: "Times New Roman",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: true,
      note: "Web fonts are linked with no Outlook fallback (no mso-font-alt, no Outlook-safe wrapper).",
    },
    {
      client: "outlook_new",
      label: "New Outlook & Outlook.com",
      likely: "Arial",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: false,
      note: "No web fonts; first installed backup.",
    },
    {
      client: "apple_mail",
      label: "Apple Mail & iOS Mail",
      likely: "Inter",
      fallbackFrom: [],
      warning: false,
      note: "Apple Mail shows the web fonts.",
    },
    {
      client: "samsung",
      label: "Samsung Email",
      likely: "Arial",
      fallbackFrom: ["Montserrat", "Inter"],
      warning: false,
      note: "Fonts are linked with <link>, which Samsung Email ignores.",
    },
  ],
  warnings: [
    "Gmail doesn't load web fonts — Gmail readers likely see Arial (Roboto on Android) instead of Montserrat and Inter.",
    "Outlook for Windows (classic) likely shows Times New Roman — the web fonts are linked with no Outlook fallback.",
  ],
  imageTextCount: 2,
  fontFamilies: ["Inter", "Montserrat"],
  usesWebFonts: true,
};

export const FONTS_TEMPLATE: FontProfile = { ...FONTS_RENDER, source: "template" };

export const FONTS_STATIC: FontProfile = {
  source: "static",
  measured: false,
  families: [
    {
      name: "Poppins",
      share: null,
      roles: [],
      class: "web",
      provider: "Google Fonts",
      weights: [
        { weight: 400, synthesized: false },
        { weight: 600, synthesized: false },
      ],
      weightNote: null,
    },
    {
      name: "Helvetica",
      share: null,
      roles: [],
      class: "system",
      provider: null,
      weights: [],
      weightNote: null,
    },
  ],
  noFontSetShare: null,
  fallbacks: ["Arial"],
  declaredUnused: [],
  clients: [],
  warnings: [],
  imageTextCount: null,
  fontFamilies: ["Poppins", "Helvetica"],
  usesWebFonts: true,
};

export const FONTS_SUMMARY: FontProfile = {
  source: "summary",
  measured: true,
  families: [
    {
      name: "Inter",
      share: 0.74,
      roles: ["body"],
      class: "web",
      provider: null,
      weights: [],
      weightNote: null,
    },
    {
      name: "Montserrat",
      share: 0.23,
      roles: ["heading"],
      class: "web",
      provider: null,
      weights: [],
      weightNote: null,
    },
  ],
  noFontSetShare: null,
  fallbacks: [],
  declaredUnused: [],
  clients: [
    {
      client: "gmail_web",
      label: "Gmail (web)",
      likely: "Arial",
      fallbackFrom: ["Inter", "Montserrat"],
      warning: false,
      note: "",
    },
    {
      client: "outlook_classic",
      label: "Outlook for Windows (classic)",
      likely: "Times New Roman",
      fallbackFrom: ["Inter", "Montserrat"],
      warning: true,
      note: "",
    },
  ],
  warnings: [],
  imageTextCount: null,
  fontFamilies: ["Inter", "Montserrat"],
  usesWebFonts: true,
};

type Design = EmailDetail["design"];

function design(partial: Partial<Design> & Pick<Design, "result" | "summary">): Design {
  const r = partial.result;
  return {
    snapshot: {
      status: "done",
      source: r?.coverage ?? partial.summary?.coverage ?? "none",
      aiState: r?.aiPending ? "pending" : r?.coverage === "template" ? "from_template" : "done",
      score: r?.score ?? partial.summary?.score ?? null,
      band: r?.band ?? partial.summary?.band ?? null,
      provisional: r?.provisional ?? false,
      capped: r?.capped ?? false,
      issues: r?.issues ?? [],
      confidence: r?.confidenceBand ?? null,
    },
    renderRef: null,
    analyzedAt: "2026-09-26T14:12:00.000Z",
    layout: { desktopHeight: 2240, mobileHeight: 3120 },
    ...partial,
  };
}

export const DESIGN_STATES: Array<{
  id: string;
  title: string;
  design: Design;
  fonts: FontProfile | null;
}> = [
  {
    id: "render-ai",
    title: "Own render + AI review",
    design: design({ result: RESULT_RENDER_AI, summary: null }),
    fonts: FONTS_RENDER,
  },
  {
    id: "ai-pending",
    title: "Own render, AI review pending",
    design: design({ result: RESULT_AI_PENDING, summary: null }),
    fonts: FONTS_RENDER,
  },
  {
    id: "template",
    title: "Scored from template",
    design: design({
      result: RESULT_TEMPLATE,
      summary: null,
      renderRef: {
        emailId: "00000000-0000-4000-8000-000000000001",
        renderedAt: "2026-09-12T09:30:00.000Z",
      },
    }),
    fonts: FONTS_TEMPLATE,
  },
  {
    id: "capped",
    title: "Capped (low contrast)",
    design: design({ result: RESULT_CAPPED, summary: null }),
    fonts: FONTS_RENDER,
  },
  {
    id: "provisional",
    title: "Provisional (template, no AI)",
    design: design({
      result: RESULT_PROVISIONAL,
      summary: null,
      renderRef: {
        emailId: "00000000-0000-4000-8000-000000000002",
        renderedAt: "2026-08-30T09:30:00.000Z",
      },
    }),
    fonts: FONTS_TEMPLATE,
  },
  {
    id: "static",
    title: "Static checks only",
    design: design({ result: RESULT_STATIC, summary: null, layout: null }),
    fonts: FONTS_STATIC,
  },
  {
    id: "summary",
    title: "Saved summary (after compaction)",
    design: design({ result: null, summary: SUMMARY }),
    fonts: FONTS_SUMMARY,
  },
];

export const MOCK_ACTIONS: EmailDetail["actions"] = {
  canAnalyze: true,
  canRunAiReview: true,
  analyzeRemainingToday: 4,
  aiReviewRemainingToday: 3,
  renderQueued: false,
  reason: null,
};
