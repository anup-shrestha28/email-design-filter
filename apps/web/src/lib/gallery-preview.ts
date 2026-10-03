/**
 * How a gallery card crops its live preview, so the design — not the white margin around it —
 * fills the card. Client-safe, pure (unit-tested in test/tests-ui/gallery-ui.test.ts).
 *
 * The card's iframe lays the email out at the same 800 px width the analysis rendered it at
 * (DESIGN-SCORE §2, `DESKTOP_WIDTH`), so the renderer's measurements line up with what the card
 * shows:
 *  - horizontally, the card zooms in on the email's visible content: the renderer measures, once,
 *    the left and right edges of everything a reader can see (text, images, painted boxes; not page
 *    backgrounds, hidden preheaders or tracking pixels — `layout.content`, @edf/design render
 *    features), and the card shows that span plus a small gutter on each side. Every design is
 *    whole AND fills its card evenly, whatever its width (reallygoodemails.com style). An email with
 *    no measurement (rendered before it existed, or nothing visible found) shows the whole canvas.
 *    The analysis' "main container" is not used: a browser audit of real mail showed it often
 *    misses the design (an inner block, or a footer scrap), which trimmed designs at the edges;
 *  - an email wider than 800 px (a fixed 886 px layout) is laid out on a wider canvas
 *    (`canvasWidth`), so it isn't cut off on the right;
 *  - vertically, every card shows the top of the email and drifts down on hover (`cardLayout`) —
 *    a plain grid. The full design (`fullFrame`) is one click away, in the detail view.
 */

/** The width the analysis renders the desktop pass at (@edf/design DESKTOP_WIDTH). */
export const RENDER_WIDTH = 800;
/** The analysis' desktop viewport height: `layout.desktopHeight` is never less than this. */
export const RENDER_VIEWPORT_HEIGHT = 1000;
/**
 * The widest canvas a preview lays an email out at: wider layouts are shown up to here and cut off
 * past it (a runaway measurement never turns a card into a thumbnail of a vast blank page).
 */
export const MAX_CANVAS_WIDTH = 1600;
/**
 * Breathing room kept on each side of the visible content (render px). The content box is measured
 * precisely, so this is only margin — enough that the design doesn't touch the card's edges.
 */
const GUTTER = 24;
/**
 * The narrowest slice a card zooms to (render px): a very narrow design (a 300 px note, a lone
 * image) sits in a little white rather than being blown up to fill the card.
 */
const MIN_CROP_WIDTH = 520;
/**
 * Room kept below the last visible content of a page no taller than the viewport (render px). The
 * measured content leaves out the invisible space an email's document usually runs on past it —
 * a transparent wrapper's bottom padding, spacer rows, the body margin, a full-bleed background
 * band — and the detail view's full-length frame is this tall. The frame stays scrollable (so
 * nothing is ever out of reach when the email lays out taller than measured, e.g. with images
 * loaded that the analysis didn't have); if it's shorter than the document it grows a nested
 * scrollbar, which also narrows the layout from 800 px and reflows the email. So this is generous:
 * a 40 px wrapper padding under a card, or a 40 px spacer row plus the body's default 8 px margins,
 * fits with room to spare (test/tests-ui/gallery-ui.test.ts, measured in Chrome).
 */
export const CONTENT_BOTTOM_ALLOWANCE = 96;

/** Where the design sits in the desktop render (from the saved layout facts). */
export interface PreviewFrame {
  /**
   * Left edge of the email's visible content, render px. Absent when it wasn't measured (rendered
   * before the measurement existed, or nothing visible was found): the card shows the whole canvas
   * rather than guess and risk clipping real content.
   */
  x?: number;
  /** Width of the visible content, render px. Absent exactly when `x` is. */
  width?: number;
  /** Where the email's content ends, render px (≥ 1). */
  contentBottom: number;
  /**
   * The width to lay the email out at when it's wider than the 800 px render (a fixed 886 px
   * layout): its visible content's right edge (or, unmeasured, its document width), at most
   * MAX_CANVAS_WIDTH. Absent when the email fits the 800 px canvas.
   */
  canvasWidth?: number;
  /**
   * The width the email lays out at on a 375 px phone (`layout.mobileContentWidth`), when it's wider
   * than the phone: a fixed 624 px layout that phone mail apps shrink to fit (k = 375 / width).
   * Absent when the email fits the phone.
   */
  phoneWidth?: number;
  /**
   * Where the email's content ends on a 375 px phone (`layout.mobileHeight`), in the phone layout's
   * own px (as the phone preview shows it, multiply by `phoneZoom(frame)`). Absent when unknown.
   */
  phoneBottom?: number;
}

/** The phone width the analysis emulates (@edf/design MOBILE_WIDTH). */
export const PHONE_WIDTH = 375;
/** A phone layout width that makes sense (wider than the phone, at most 4× it). */
function phoneWidthOf(v: unknown): number | undefined {
  return finite(v) && v > PHONE_WIDTH + 1 && v <= PHONE_WIDTH * 4 ? Math.round(v) : undefined;
}

/**
 * How much the Phone preview shrinks an email, like a phone mail app's "fit to screen" (Gmail,
 * Apple Mail): an email wider than the phone (`phoneWidth`, the width the analysis measured at
 * 375 px — a fixed 600 px table) is shown shrunk to the screen (`scale` < 1, the caption's
 * percentage), however wide, instead of running off its right edge. One that fits, or wasn't
 * measured, is shown at full size. The frame itself is always laid out at 375 px (`phoneZoom`).
 */
export function phoneFit(frame: Pick<PreviewFrame, "phoneWidth"> | null | undefined): {
  layoutWidth: number;
  scale: number;
} {
  const w = frame?.phoneWidth;
  if (!w || !(w > PHONE_WIDTH)) return { layoutWidth: PHONE_WIDTH, scale: 1 };
  return { layoutWidth: w, scale: PHONE_WIDTH / w };
}

/**
 * The zoom the phone preview shows an email at (1 when it fits the phone). The phone preview (the
 * gallery detail's Phone, the email page's Mobile 375) is always a frame exactly PHONE_WIDTH wide,
 * so the email lays out as in the analysis' phone pass: its width media queries see a 375 px
 * screen, and the viewer reads its device-width ones as the frame's width (@edf/sanitize
 * `phoneWidth`). What is still wider than the phone there (`phoneWidth`, measured in that pass)
 * is zoomed out to fit, as phone mail apps do; the viewer document applies this zoom itself, in
 * the phone frame only (server/view-source.ts `phoneFitCss`), and the frame is
 * `phoneBottom × zoom` tall. `phoneWidth` is rounded, so the zoom is taken over one px more and
 * rounded down: a fraction of a px over could otherwise scroll the frame sideways.
 */
export function phoneZoom(frame: Pick<PreviewFrame, "phoneWidth"> | null | undefined): number {
  const fit = phoneFit(frame);
  if (fit.scale >= 1) return 1;
  return Math.floor((PHONE_WIDTH / (fit.layoutWidth + 1)) * 10_000) / 10_000;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The renderer caps measured heights here (packages/render extract: `Math.min(1_000_000, …)`). */
const MAX_MEASURED_HEIGHT = 1_000_000;

/** A phone content height that makes sense (at least 1 px, at most the renderer's cap). */
function phoneBottomOf(v: unknown): number | undefined {
  return finite(v) && v >= 1 && v <= MAX_MEASURED_HEIGHT ? Math.round(v) : undefined;
}

/** A canvas width that makes sense (wider than the 800 px render, at most MAX_CANVAS_WIDTH). */
function canvasWidthOf(v: unknown): number | undefined {
  return finite(v) && v > RENDER_WIDTH && v <= MAX_CANVAS_WIDTH ? Math.ceil(v) : undefined;
}

/** The renderer's visible-content extent (`layout.content`), when it's there and makes sense. */
function contentOf(v: unknown): { left: number; right: number; bottom: number } | null {
  if (typeof v !== "object" || v === null) return null;
  const c = v as Record<string, unknown>;
  if (!finite(c.left) || !finite(c.right) || !finite(c.bottom)) return null;
  if (c.left < 0 || c.left >= c.right || c.bottom <= 0 || c.bottom > MAX_MEASURED_HEIGHT)
    return null;
  return { left: c.left, right: c.right, bottom: c.bottom };
}

/**
 * The card frame from a saved layout, server side — either `score_summary.layout` (@edf/design
 * SummaryLayout) or the raw `features.render.layout`; both carry `desktopHeight`, `mobileHeight`,
 * `mobileContentWidth` and, from renders that measured it, `content` (and `desktopContentWidth`).
 * Null when the email wasn't rendered or the facts don't make sense. Also accepts an already-built
 * PreviewFrame, so the client can re-validate what it was sent.
 */
export function previewFrameOf(layout: unknown): PreviewFrame | null {
  if (typeof layout !== "object" || layout === null) return null;
  const l = layout as Record<string, unknown>;
  // An already-built frame, x/width included or not (the client re-validating what it was sent).
  if (finite(l.contentBottom)) {
    if (l.contentBottom <= 0) return null;
    const canvasWidth = canvasWidthOf(l.canvasWidth);
    const x = finite(l.x) ? l.x : undefined;
    const width = finite(l.width) ? l.width : undefined;
    // Half a box (x without width, or the reverse) is nonsense: drop both, keep the height.
    const box = x !== undefined && width !== undefined ? { x, width } : null;
    const canvas = canvasWidth ?? RENDER_WIDTH;
    if (box && (box.width <= 0 || box.x < 0 || box.x + box.width > canvas + 1)) return null;
    const phoneWidth = phoneWidthOf(l.phoneWidth);
    const phoneBottom = phoneBottomOf(l.phoneBottom);
    return {
      ...(box ?? {}),
      contentBottom: l.contentBottom,
      ...(canvasWidth ? { canvasWidth } : {}),
      ...(phoneWidth ? { phoneWidth } : {}),
      ...(phoneBottom ? { phoneBottom } : {}),
    };
  }
  const height = l.desktopHeight;
  if (!finite(height) || height <= 0) return null;
  const content = contentOf(l.content);
  const phoneWidth = phoneWidthOf(l.mobileContentWidth);
  const phoneBottom = phoneBottomOf(l.mobileHeight);
  // Wider than the 800 px render: lay it out wider, so it isn't cut off on the right. When the
  // visible content was measured, its right edge decides — the document can be wider than what's
  // visible (an invisible spacer), and widening the canvas for that would re-centre the design away
  // from where it was measured. Unmeasured, the document's own width is all there is.
  const docWidth = finite(l.desktopContentWidth) ? l.desktopContentWidth : undefined;
  const widest = content ? content.right : docWidth;
  const canvasWidth =
    widest !== undefined && widest > RENDER_WIDTH
      ? Math.min(MAX_CANVAS_WIDTH, Math.ceil(widest))
      : undefined;
  const canvas = canvasWidth ?? RENDER_WIDTH;
  // The visible content's span, in whole px, never past the canvas.
  const left = content ? Math.floor(content.left) : 0;
  const right = content ? Math.min(canvas, Math.ceil(content.right)) : 0;
  const box = content && right > left ? { x: left, width: right - left } : null;
  // A page taller than the viewport measured its real height; a shorter one reports the viewport,
  // so its content ends where the last visible thing does, plus CONTENT_BOTTOM_ALLOWANCE for the
  // invisible space the document runs on past it (never past the viewport height, which the whole
  // document fits in). Unmeasured, the viewport height stands: a little white under a short email,
  // never an email cut short. (The main container's bottom used to be the estimate here, but it
  // can be an inner block — and the detail view sizes its full-length frame from this, so an
  // underestimate would give the email a nested scrollbar there.)
  const contentBottom =
    height > RENDER_VIEWPORT_HEIGHT || !content
      ? height
      : Math.min(height, Math.max(1, content.bottom + CONTENT_BOTTOM_ALLOWANCE));
  return {
    ...(box ?? {}),
    contentBottom: Math.round(contentBottom),
    ...(canvasWidth ? { canvasWidth } : {}),
    ...(phoneWidth ? { phoneWidth } : {}),
    ...(phoneBottom ? { phoneBottom } : {}),
  };
}

export interface CardCrop {
  /** The iframe's layout width: the canvas (800 px, or the email's own width when it's wider). */
  renderWidth: number;
  /** Left edge of the visible slice, render px. */
  cropX: number;
  /** Width of the visible slice, render px (the card's width maps to this). */
  cropWidth: number;
  /** Where the content ends, render px, or null when unknown. */
  contentBottom: number | null;
}

/**
 * The horizontal slice of the render a card shows: the visible content plus GUTTER on each side
 * (at least MIN_CROP_WIDTH wide, at most the whole canvas), centred on the content and kept inside
 * the canvas. Unmeasured content: the whole canvas.
 */
export function cardCrop(frame: PreviewFrame | null): CardCrop {
  const renderWidth = frame?.canvasWidth ?? RENDER_WIDTH;
  const contentBottom = frame?.contentBottom ?? null;
  // Where the design sits isn't known (not rendered yet, or not measured): show the whole canvas.
  // A little extra margin never hides anything; a guessed slice can cut real content off.
  if (frame?.x === undefined || frame.width === undefined) {
    return { renderWidth, cropX: 0, cropWidth: renderWidth, contentBottom };
  }
  // Whole px (the canvas width is whole too), so the slice never reaches past the canvas' edge.
  const cropWidth = Math.round(
    Math.min(renderWidth, Math.max(MIN_CROP_WIDTH, frame.width + 2 * GUTTER)),
  );
  const center = frame.x + frame.width / 2;
  const cropX = Math.round(Math.min(renderWidth - cropWidth, Math.max(0, center - cropWidth / 2)));
  return { renderWidth, cropX, cropWidth, contentBottom };
}

/**
 * The tallest a card's preview gets, as a multiple of its width: about 85% of real mail fits whole
 * (measured on the owner's 340 rendered emails: median 1.7×, 75th percentile 2.3×, 90th 3.7×).
 * A longer email shows its top this tall, with a soft fade (Pinterest style); the whole email is
 * one click away in the detail view.
 */
export const CARD_MAX_RATIO = 3;
/** The shortest a card's preview gets (a one-line notice still reads as a sheet, not a strip). */
export const CARD_MIN_RATIO = 0.6;
/** An email whose length isn't known yet (not rendered): a square, like before. */
export const CARD_UNKNOWN_RATIO = 1;

export interface CardShape {
  /** Preview height ÷ width. */
  ratio: number;
  /** Cut at CARD_MAX_RATIO: the card shows the top of a longer email, fading out. */
  capped: boolean;
  /** The email's length was measured (false: CARD_UNKNOWN_RATIO stands in). */
  known: boolean;
}

/**
 * A masonry card's preview shape: the whole email at the card's width — its content height over
 * the slice the card shows (cardCrop) — clamped to CARD_MIN_RATIO..CARD_MAX_RATIO.
 */
export function cardShape(crop: CardCrop): CardShape {
  const bottom = crop.contentBottom;
  if (!finite(bottom) || bottom <= 0 || !(crop.cropWidth > 0)) {
    return { ratio: CARD_UNKNOWN_RATIO, capped: false, known: false };
  }
  // +2 render px: the same allowance the card's frame gets, so the email's last pixels show.
  const whole = (bottom + 2) / crop.cropWidth;
  return {
    ratio: Math.min(CARD_MAX_RATIO, Math.max(CARD_MIN_RATIO, whole)),
    capped: whole > CARD_MAX_RATIO,
    known: true,
  };
}

/**
 * Masonry: each card goes to the column that is shortest so far (Pinterest style), given each
 * card's height as a multiple of the column width plus a fixed part (its footer and the gap, in
 * px). Returns the indices of `heights` per column, in order. Ties go to the leftmost column, so
 * the first row reads left to right in the list's order.
 */
export function masonryColumns(
  ratios: readonly number[],
  columns: number,
  columnWidth: number,
  fixedPx: number,
): number[][] {
  const n = Math.max(1, Math.floor(columns));
  const out: number[][] = Array.from({ length: n }, () => []);
  const filled = new Array<number>(n).fill(0);
  ratios.forEach((r, i) => {
    let best = 0;
    for (let c = 1; c < n; c++) if (filled[c]! < filled[best]! - 0.5) best = c;
    out[best]!.push(i);
    filled[best]! += (finite(r) && r > 0 ? r : CARD_UNKNOWN_RATIO) * columnWidth + fixedPx;
  });
  return out;
}

export interface CardLayout {
  /** Scale from render px to card px. */
  scale: number;
  /** How far (card px) the preview may drift up on hover: 0 when the email fits the box. */
  drift: number;
  /**
   * The iframe's height in render px: the box plus the drift (so drifting never shows a gap), and
   * never less than the whole box. A short email's own document (its body background, white by
   * default) therefore fills the preview to the bottom, like a sheet of paper, instead of leaving
   * the card's surface showing under it.
   */
  frameHeight: number;
}

/**
 * Scale, hover drift and iframe height for a card box of `boxWidth` × `boxHeight` px (the box as
 * measured: the fixed card shape, or taller when the card grows to its grid row — see gallery-card.tsx
 * PREVIEW_BOX). The drift is clamped to what's left of the email below the box (at most one more
 * box), and is 0 when the email is short or its length is unknown; the frame always covers the
 * whole box.
 */
export function cardLayout(crop: CardCrop, boxWidth: number, boxHeight: number): CardLayout {
  const scale = boxWidth > 0 ? boxWidth / crop.cropWidth : 1;
  const rest = crop.contentBottom === null ? 0 : crop.contentBottom * scale - boxHeight;
  const raw = Math.max(0, Math.min(boxHeight, Math.floor(rest)));
  const drift = raw < 24 ? 0 : raw;
  // +2 render px so rounding never leaves a hairline of the card's surface at the bottom.
  const frameHeight = Math.ceil((boxHeight + drift) / scale) + 2;
  return { scale, drift, frameHeight };
}

/**
 * The detail view's full-height frame (click to open): the iframe is `bottom + 2` px of layout
 * tall (never cut), shown at `scale` (so it takes `shownHeight` px of the page). Null when the
 * length is unknown, and the preview scrolls inside its pane instead. The grid cards themselves
 * show only the top of the email (reallygoodemails.com style; see gallery-card.tsx PREVIEW_BOX) —
 * the full design is one click away.
 */
export function fullFrame(
  bottom: number | null | undefined,
  scale: number,
): { frameHeight: number; shownHeight: number } | null {
  if (!finite(bottom) || bottom <= 0 || !(scale > 0)) return null;
  const frameHeight = Math.ceil(bottom) + 2;
  return { frameHeight, shownHeight: Math.ceil(frameHeight * scale) };
}
