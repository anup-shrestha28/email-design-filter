/**
 * Synthetic features for unit tests: a well-designed promotional email by default, with
 * deep-merge overrides for each scenario.
 */
import type {
  AiReview,
  DesignFeatures,
  FontFeatures,
  RenderFeatures,
  ScoreContext,
  StaticDesignFeatures,
} from "../../src/index";

type DeepPartial<T> =
  T extends Array<infer _U> ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

export function merge<T>(base: T, over: NoInfer<DeepPartial<T>> | undefined): T {
  if (over === undefined) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over as T);
  const out: Record<string, unknown> = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    out[k] =
      isPlainObject(out[k]) && isPlainObject(v)
        ? merge<unknown>(out[k], v as never)
        : structuredClone(v);
  }
  return out as T;
}

export function baseStatic(over?: DeepPartial<StaticDesignFeatures>): StaticDesignFeatures {
  const s: StaticDesignFeatures = {
    v: 1,
    htmlBytes: 24_000,
    lang: { html: "en", wrapper: "en" },
    dir: { html: "ltr", wrapper: "ltr" },
    script: { kind: "latin", cased: true },
    title: true,
    aria: { roleButtonOnLink: 0, vmlWithoutAlt: 0, ariaHiddenBody: false },
    tables: { total: 4, layout: 4, presentational: 4 },
    images: {
      total: 4,
      withAlt: 3,
      informative: 2,
      informativeMeaningful: 2,
      pixels: 1,
      content: 3,
    },
    links: {
      total: 6,
      named: 6,
      generic: 0,
      http: 0,
      https: 6,
      emptyOrHash: 0,
      javascript: 0,
      placeholder: 0,
    },
    mergeTags: { body: 0, firstScreen: false },
    clip: { visibleChars: 2000, afterClipChars: 0, clipBytes: 102_000 },
    style: { bytes: 6_000, mediaRules: 1, mediaAfterLimit: false },
    compat: [],
    footer: {
      unsubscribe: "before_clip",
      unsubscribeByHeader: true,
      preferences: true,
      receiving: true,
      postalAddress: true,
    },
    cta: {
      buttonLike: 1,
      labels: ["shop rain shells"],
      primaryLabel: "shop rain shells",
      primaryOffset: 3_000,
    },
    caps: { chars: 1500, caps: 30 },
    prose: { words: 240, sentences: 16, syllables: 340 },
    text: { visibleChars: 2000, words: 320, codeShare: 0 },
    hasViewport: true,
  };
  return merge(s, over);
}

export function baseRender(over?: DeepPartial<RenderFeatures>): RenderFeatures {
  const r: RenderFeatures = {
    v: 1,
    meta: {
      chromium: "Chrome/148",
      rendererVersion: "render-2026.1",
      fontBundle: "fonts-2026.09",
      lite: false,
      passes: ["D", "D0", "M", "M-nomq", "M-off"],
      domNodes: 400,
      screenshotClipped: false,
    },
    layout: {
      desktopHeight: 1800,
      mobileHeight: 2400,
      desktopContentWidth: 800,
      mobileContentWidth: 375,
      nomqContentWidth: 375,
      k: 1,
      kNomq: 1,
      mainContainer: { x: 100, y: 0, w: 600, h: 1800 },
    },
    text: {
      script: "latin",
      cased: true,
      chars: {
        total: 2000,
        outsideFooter: 1800,
        body: 1500,
        heading: 200,
        button: 20,
        navigation: 0,
        footer: 200,
        legible: 1700,
      },
      medianAll: { desktop: 16, mobile: 16 },
      body: { desktop: 16, mobile: 16, fallback: false },
      lineRatio: 1.5,
      paragraphLines: 20,
      charsPerLine: 60,
      alignment: { chars: 1500, badChars: 0 },
      sizes: [
        [13, 200],
        [16, 1500],
        [17, 20],
        [28, 200],
      ],
      caps: { chars: 1500, caps: 30 },
      headings: { visual: 3, markedUp: 3, h1: 1 },
      firstViewportMaxPx: 28,
      firstViewportLegible: 300,
      blockWidths: [[340, 1500]],
      gutters: [[20, 1500]],
      readingOrderTau: 1,
      words: 300,
      avgParagraphLines: 3,
      maxWordsBetweenHeadings: 120,
      alignmentAnchors: 3,
    },
    contrast: {
      groups: [
        {
          fg: "#374151",
          bg: "#ffffff",
          ratio: 10.31,
          p90: null,
          method: "color",
          large: false,
          role: "body",
          rendered: true,
          short: false,
          chars: 1500,
        },
        {
          fg: "#111827",
          bg: "#ffffff",
          ratio: 17.74,
          p90: null,
          method: "color",
          large: true,
          role: "heading",
          rendered: true,
          short: false,
          chars: 200,
        },
        {
          fg: "#ffffff",
          bg: "#0b5fff",
          ratio: 5.2,
          p90: null,
          method: "color",
          large: false,
          role: "button",
          rendered: true,
          short: true,
          chars: 20,
        },
        {
          fg: "#4b5563",
          bg: "#ffffff",
          ratio: 7.56,
          p90: null,
          method: "color",
          large: false,
          role: "footer",
          rendered: true,
          short: false,
          chars: 200,
        },
      ],
    },
    links: {
      total: 6,
      standalone: 3,
      inline: 3,
      inlineDistinguishable: 3,
      targets: [
        [200, 48, true],
        [160, 40, true],
        [80, 30, true],
      ],
    },
    cta: {
      primary: {
        label: "Shop rain shells",
        words: 3,
        live: true,
        target: { x: 20, y: 420, w: 200, h: 48 },
        visual: { x: 20, y: 420, w: 200, h: 48 },
        labelContrast: 5.2,
        labelLarge: false,
        fillLumRatio: 5.2,
        fillDeltaE: 55,
        mostProminent: true,
        offset: 3000,
      },
      buttonLike: 1,
      labels: ["shop rain shells"],
      firstTwoViewportsDistinct: 1,
      buttonStyles: 1,
    },
    images: {
      content: 3,
      informative: 2,
      logoTop: true,
      share: 0.3,
      loads: [
        { status: 200, decoded: true },
        { status: 200, decoded: true },
        { status: 200, decoded: true },
      ],
      bytes: 300_000,
      adapt: [{ withinViewport: true, aspectDev: 0.01, sharpRatio: 2, renderedWidth: 600 }],
      alt: { total: 3, withAlt: 3, informative: 2, informativeMeaningful: 2 },
      darkMode: [],
    },
    imagesOff: { on: 400, off: 380 },
    footer: {
      present: true,
      top: 2000,
      unsubscribe: { px: 13, contrast: 7.56 },
      postalAddress: true,
      receiving: true,
    },
    clip: {
      clipBytes: 102_000,
      visibleChars: 2000,
      afterClipChars: 0,
      ctaAfterClip: false,
      unsubscribeAfterClip: false,
    },
    mergeTagFirstViewport: false,
    pixels: {
      whitespace: 0.7,
      edgeDensity: 0.08,
      pngBytesPerPixel: 0.5,
      xyLeaves: 20,
      dominantColours: 4,
      colourfulness: 30,
    },
    components: { gapClusters: 4, accentHues: 1 },
    axe: { layoutTables: 4, presentationalLayoutTables: 4, violations: [] },
    regions: [],
    info: { linkCount: 6, imageArea: 200_000, textArea: 90_000, readingTimeSec: 78 },
  };
  return merge(r, over);
}

export function baseFonts(over?: DeepPartial<FontFeatures>): FontFeatures {
  const f: FontFeatures = {
    v: 1,
    static: {
      v: 1,
      declarations: [],
      providerLinks: [],
      msoOverrides: [],
      stacks: [{ css: "Helvetica, Arial, sans-serif", chars: 1800 }],
      typekitCounter: false,
      truncated: false,
    },
    used: {
      v: 1,
      stacks: [
        {
          css: "Helvetica, Arial, sans-serif",
          chars: 2000,
          cjkChars: 0,
          roles: { heading: 200, body: 1500, button: 20, navigation: 0, footer: 280 },
          weights: [
            [400, 1780],
            [700, 220],
          ],
          otherWeightChars: 0,
        },
      ],
      otherChars: 0,
      totalChars: 2000,
      imageTextCount: null,
    },
  };
  return merge(f, over);
}

export function baseAi(over?: DeepPartial<AiReview>): AiReview {
  const lvl = (level: number) => ({
    level,
    evidence: "Clear headline and one blue button above the fold.",
    region: "top" as const,
  });
  const a: AiReview = {
    criteria: { H7: lvl(4), L8: lvl(4), I6: lvl(4), C4: lvl(4) },
    flags: { suspected_prompt_injection: false, render_problem: false },
    injectionPatternHit: false,
    model: "claude-opus-5",
    reviewedAt: "2026-09-26T10:00:00Z",
    source: "email",
    refused: false,
  };
  return merge(a, over);
}

export function baseFeatures(over?: {
  static?: DeepPartial<StaticDesignFeatures>;
  render?: DeepPartial<RenderFeatures> | null;
  fonts?: DeepPartial<FontFeatures>;
  ai?: AiReview | null;
  renderSource?: DesignFeatures["renderSource"];
}): DesignFeatures {
  const render = over?.render === null ? null : baseRender(over?.render ?? undefined);
  return {
    v: 1,
    static: baseStatic(over?.static),
    render,
    renderSource: over?.renderSource ?? (render ? "render" : "none"),
    renderRef: null,
    fonts: baseFonts(over?.fonts),
    ai: over?.ai === undefined ? baseAi() : over.ai,
  };
}

export function baseCtx(over?: Partial<ScoreContext>): ScoreContext {
  return {
    primaryType: "promotional",
    isSubscription: true,
    typeConfidence: 0.9,
    subject: "Rain shells, 25% off this weekend",
    snippet: "Lightweight, packable rain shells with free repairs for life — this weekend only.",
    receivedAt: new Date("2026-09-25T12:00:00Z"),
    now: new Date("2026-09-26T12:00:00Z"),
    listUnsubscribeHttps: ["https://tidewell-outdoor.com/unsubscribe?u=7f3a"],
    senderDomain: "tidewell-outdoor.com",
    language: "en",
    ...over,
  };
}
