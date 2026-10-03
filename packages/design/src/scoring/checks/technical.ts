/**
 * Technical Health — 5 points (DESIGN-SCORE §5.8), and Footer & Unsubscribe UX — 5 points (§5.9).
 */
import { CLIP_BYTES, NEAR_CLIP_BYTES } from "../../constants";
import { webFontCompat } from "../../fonts/profile";
import { clamp, ramp } from "../../util/math";
import type { UnsubscribeFind } from "../../types";
import { hasMergeTag } from "../../util/patterns";
import {
  KILOBYTE,
  X2_CLIENT_SHARES,
  X2_SEVERITY,
  X2_UNSUPPORTED,
  type X2Client,
  type X2Feature,
} from "../weights";
import { type CheckFn, type CheckInput, type CheckTable, notApplicable, r3, scored } from "../kit";

/** Share of visible text after the clip offset: own render when available, else the static estimate. */
export function clipShareAfter(input: CheckInput): number {
  if (input.ownRender && input.render) {
    const c = input.render.clip;
    return c.visibleChars > 0 ? c.afterClipChars / c.visibleChars : 0;
  }
  const c = input.static.clip;
  return c.visibleChars > 0 ? c.afterClipChars / c.visibleChars : 0;
}

/**
 * X1 Gmail clipping — B ≤ 90,000 → 1; ≤ 102,000 → `1 − 0.5·ramp(B, NEAR, CLIP)`;
 * beyond → `0.5 × (1 − share of visible text after the clip offset)`.
 */
export const checkX1: CheckFn = (input) => {
  const b = input.static.htmlBytes;
  if (b <= NEAR_CLIP_BYTES) return scored(1, { bytes: b });
  if (b <= CLIP_BYTES)
    return scored(1 - 0.5 * ramp(b, NEAR_CLIP_BYTES, CLIP_BYTES), { bytes: b, nearClip: true });
  const after = clipShareAfter(input);
  return scored(0.5 * (1 - after), { bytes: b, clipped: true, afterShare: r3(after) });
};

export interface CompatRisk {
  risk: number;
  pairs: Array<{ feature: X2Feature; client: X2Client }>;
}

/**
 * X2 risk = `1 − Π(1 − sev × share_client × unsupported)` over features used without a detected
 * fallback. Web fonts: a stack with no working fallback affects every client without web-font
 * support; the classic-Outlook Times New Roman condition affects classic Outlook even when the
 * stack has fallbacks (DESIGN.md §8.1 step 3).
 */
export function compatRisk(input: CheckInput): CompatRisk {
  const used: Array<{ feature: X2Feature; clients: readonly X2Client[] | null }> = [];
  for (const f of input.static.compat) if (!f.fallback) used.push({ feature: f.id, clients: null });
  const wf = webFontCompat(input.fonts, input.fontProfile.measured);
  if (wf.noFallbackStack) used.push({ feature: "web_font", clients: null });
  else if (wf.outlookTnr) used.push({ feature: "web_font", clients: ["outlook_classic"] });
  let keep = 1;
  const pairs: CompatRisk["pairs"] = [];
  for (const { feature, clients } of used) {
    const sev = X2_SEVERITY[feature];
    const support = X2_UNSUPPORTED[feature];
    for (const client of Object.keys(X2_CLIENT_SHARES) as X2Client[]) {
      if (clients && !clients.includes(client)) continue;
      const u = feature === "web_font" && clients ? 1 : support[client];
      if (u <= 0) continue;
      keep *= 1 - sev * X2_CLIENT_SHARES[client] * u;
      pairs.push({ feature, client });
    }
  }
  return { risk: 1 - keep, pairs };
}

export const checkX2: CheckFn = (input) => {
  const { risk, pairs } = compatRisk(input);
  const features = [...new Set(pairs.map((p) => p.feature))];
  return scored(1 - risk, { risk: r3(risk), features });
};

/**
 * X3 Personalization & link integrity — `1 − 0.25 × n_defect_classes − 0.25 × (1 − https_share)`:
 * (1) unrendered merge tags (code excluded), (2) empty/#/javascript: hrefs on visible links,
 * (3) placeholder domains, (4) NXDOMAIN link domains (when the pipeline supplies DNS results).
 */
export const checkX3: CheckFn = (input) => {
  const l = input.static.links;
  const mergeTags =
    input.static.mergeTags.body > 0 || (!!input.ctx.subject && hasMergeTag(input.ctx.subject));
  const badHrefs = l.emptyOrHash + l.javascript > 0;
  const placeholder = l.placeholder > 0;
  const nxdomain = (input.ctx.linkDnsFailures ?? 0) > 0;
  const classes = [mergeTags, badHrefs, placeholder, nxdomain].filter(Boolean).length;
  const web = l.http + l.https;
  const httpsShare = web > 0 ? l.https / web : 1;
  return scored(clamp(1 - 0.25 * classes - 0.25 * (1 - httpsShare), 0, 1), {
    mergeTags,
    badHrefs,
    placeholder,
    nxdomain,
    httpsShare: r3(httpsShare),
  });
};

/** X4 Style budget — `ramp(<style> bytes, 32 KB, 16 KB)`, −0.5 if an @media starts after byte 16,384. */
export const checkX4: CheckFn = (input) => {
  const st = input.static.style;
  const s = ramp(st.bytes, 32 * KILOBYTE, 16 * KILOBYTE) - (st.mediaAfterLimit ? 0.5 : 0);
  return scored(clamp(s, 0, 1), { bytes: st.bytes, mediaAfterLimit: st.mediaAfterLimit });
};

/** Where the unsubscribe link is, both passes together (U1 `unsubscribe`, the saved signal). */
export type UnsubscribePlace = "before_clip" | "after_clip" | "none";

/** The static HTML pass's answer; null when that pass failed (`static.unavailable`). */
export function staticUnsubscribe(input: CheckInput): UnsubscribeFind | null {
  if (input.static.unavailable === true) return null;
  const u = input.static.footer.unsubscribe;
  return u === "before_clip" ? "found" : u;
}

/**
 * The render's answer for this email: a link found in the footer at 375 (`footer.unsubscribe`),
 * after the clip offset when `clip.unsubscribeAfterClip`. Its own render only: a template sample's
 * footer is another email's (like U4 / H4 / A2, which never borrow a sample's content), so it
 * answers only when this email's static pass failed and the sample is all there is (its byte
 * offsets still don't place the link). null without a render or for a sample.
 */
export function renderUnsubscribe(input: CheckInput): UnsubscribeFind | null {
  const r = input.render;
  if (!r) return null;
  if (!input.ownRender && input.static.unavailable !== true) return null;
  if (!r.footer.unsubscribe) return "none";
  return input.ownRender && r.clip.unsubscribeAfterClip === true ? "after_clip" : "found";
}

/**
 * The static pass's answer over the links a reader can see (render-2026.6): its unsubscribe links
 * (`footer.unsubscribeOffsets`) less the ones the email's own render shows drawing nothing
 * (`links.hidden`, matched by `data-o` byte offset; past the last listed offset when the list is
 * full, `hiddenMore`, a link counts as hidden too: the render couldn't vouch for it). The HTML
 * pass reads inline styles and simple tag / class / id rules only, so a link hidden by a
 * descendant selector, an @media rule or text the colour of its background used to count as
 * found — a sender could game U1. A link the render drew still counts, whether or not the
 * render's own detector knew it for an unsubscribe link (Truecaller's "Click <a>here</a> to
 * unsubscribe": only the static pass reads the sentence). Without both lists (older passes, a
 * template sample's render, a link with no source position) the static answer stands. `hidden`:
 * how many of the static pass's links the render showed hidden.
 */
export function staticUnsubscribeShown(input: CheckInput): {
  find: UnsubscribeFind | null;
  hidden: number;
} {
  const find = staticUnsubscribe(input);
  const offsets = input.static.footer.unsubscribeOffsets;
  const render = input.ownRender ? input.render : null;
  const hiddenList = render?.links.hidden;
  if (find === null || find === "none" || !offsets || !hiddenList) return { find, hidden: 0 };
  const hiddenSet = new Set(hiddenList);
  const last = hiddenList.length > 0 ? hiddenList[hiddenList.length - 1]! : -1;
  const more = render?.links.hiddenMore === true;
  let before = false;
  let after = false;
  let hidden = 0;
  for (const o of offsets) {
    if (hiddenSet.has(o) || (more && o > last)) hidden++;
    else if (o < CLIP_BYTES) before = true;
    else after = true;
  }
  return { find: before ? "found" : after ? "after_clip" : "none", hidden };
}

/**
 * The unsubscribe link, static ∪ render (methodology 2026.5): found by either pass → found. A link
 * the static pass found before the clip offset is one a reader reaches before Gmail's cut, whatever
 * the render's footer link does (an early "click here to unsubscribe" sentence and a footer link
 * after the cut); else the render's place when it found the link (else the static pass's); "none"
 * only when both passes looked and found nothing (for a template email, its static pass alone);
 * null when one found nothing and the other couldn't look (a failed static pass, no render). The
 * static pass used to decide alone and lost links inside MJML / Klaviyo `font-size:0` wrappers
 * (39 false "no unsubscribe" in the 2026-10-01 audit). From render-2026.6 the static pass counts
 * only the links the email's own render doesn't show hidden (`staticUnsubscribeShown`).
 */
export function unsubscribeUnion(input: CheckInput): UnsubscribePlace | null {
  const s = staticUnsubscribeShown(input).find;
  const r = renderUnsubscribe(input);
  if (s === "found") return "before_clip";
  if (r === "after_clip") return "after_clip";
  if (r === "found") {
    // Placed by the render only when its own clip mapping says "before"; else the static pass's
    // place when it has one.
    const placed = input.ownRender && input.render?.clip.unsubscribeAfterClip === false;
    return !placed && s === "after_clip" ? "after_clip" : "before_clip";
  }
  if (s === "after_clip") return "after_clip";
  // A template email has no render of its own: the static pass is the one that read it.
  const template = input.render !== null && !input.ownRender;
  return s === "none" && (r === "none" || (r === null && template)) ? "none" : null;
}

/**
 * U1 Visible unsubscribe link — before the clip offset 1, only after it 0.3, none 0; from both
 * passes (`unsubscribeUnion`); not evaluated when neither could tell. `static` / `render` keep
 * each pass's own answer; `staticHidden` counts the static pass's links the render showed hidden.
 */
export const checkU1: CheckFn = (input) => {
  const u = unsubscribeUnion(input);
  const shown = staticUnsubscribeShown(input);
  const passes = {
    static: staticUnsubscribe(input),
    render: renderUnsubscribe(input),
    // The static pass's links the render showed hidden (render-2026.6), when there were any.
    ...(shown.hidden > 0 ? { staticHidden: shown.hidden } : {}),
  };
  if (u === null)
    return { status: "not_evaluated", s: null, value: { reason: "unknown", ...passes } };
  return scored(u === "before_clip" ? 1 : u === "after_clip" ? 0.3 : 0, {
    unsubscribe: u,
    ...passes,
  });
};

/** U2 Unsubscribe legibility — mean of `ramp(px × k, 9, 12)` and `ramp(contrast, 2.5, 4.5)`. */
export const checkU2: CheckFn = (input) => {
  if (!input.render) return { status: "not_evaluated", s: null, value: { reason: "no_render" } };
  const u = input.render.footer.unsubscribe;
  if (!u) return notApplicable({ reason: "no_unsubscribe_link" });
  const k = input.render.layout.k;
  const px = u.px * k;
  const credit = (x: number) => (ramp(x, 9, 12) + ramp(u.contrast, 2.5, 4.5)) / 2;
  const s = credit(px);
  return scored(s, {
    px: r3(px),
    cssPx: r3(u.px),
    contrast: r3(u.contrast),
    // Only the fixed-width shrink makes it small (it would pass at its own size): a symptom of
    // the fixed-width layout, reported inside that root-cause item (DECISIONS.md #26).
    shrinkOnly: k < 0.99 && s < 0.9 && credit(u.px) >= 0.9,
  });
};

/** U3 Preference management — a manage-preferences or frequency link exists. */
export const checkU3: CheckFn = (input) =>
  scored(input.static.footer.preferences ? 1 : 0, { present: input.static.footer.preferences });

/** U4 "Why you're receiving this" — the statement is present. */
export const checkU4: CheckFn = (input) => {
  const present =
    input.static.footer.receiving || (input.ownRender && !!input.render?.footer.receiving);
  return scored(present ? 1 : 0, { present });
};

export const TECHNICAL_CHECKS: CheckTable = { X1: checkX1, X2: checkX2, X3: checkX3, X4: checkX4 };
export const FOOTER_CHECKS: CheckTable = { U1: checkU1, U2: checkU2, U3: checkU3, U4: checkU4 };
