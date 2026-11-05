import type { Metadata } from "next";
import type { PillarId } from "@edf/design/types";
import { BAD_MISSES_MIN, CHECKLIST_RULES, type ChecklistRuleId } from "@edf/design/checklist";
import { BandPill } from "@/components/ui/band-pill";
import { ProsePage } from "@/components/site/site-chrome";
import { CHECKLIST_RULE_COUNT, VERDICT_LABELS } from "@/lib/gallery";
import { PILLAR_LABELS, PILLAR_WEIGHTS } from "@/lib/labels";

export const metadata: Metadata = { title: "How we judge designs" };

/**
 * How each rule is checked (@edf/design scoring/checklist.ts), in plain words. Only what the
 * measurements really decide; what they can't see is said.
 */
const RULE_HOW: Record<ChecklistRuleId, string> = {
  message:
    "The top of the email leads with a big picture, a bold headline band or a real headline, and the first screens push one action, not several.",
  button:
    "There's a real button, not just text links, and not three or more look-alike buttons competing for different actions.",
  hero: "The first screen opens with a big picture or a bold headline band.",
  hierarchy: "The headline is clearly bigger than the body text, so it's obvious what matters most.",
  scan: "Text comes in short chunks with headings, not walls of text. A short email has nothing to break up, so this doesn't apply to it.",
  width: "On desktop the email is about 600px wide.",
  mobile:
    "It fits a phone screen without shrinking, and its text isn't squeezed into narrow columns or running to the screen edge.",
  fonts:
    "No more than two font families. Whether they're the brand's own fonts isn't something we can measure.",
  colors:
    "A small, consistent set of colours. Whether they're the brand's own colours isn't something we can measure.",
  body: "Body text is at least 14px on a phone, with roomy lines (about 1.5× the text size).",
  cta: "The button says what happens (“Shop the sale”, not “Click here” or “Learn more”) and stands out from the rest of the email.",
  contrast: "The main text stands out clearly from its background (WCAG AA, 4.5:1).",
  images:
    "The pictures load and most have a real description for people who can't see them. An email without pictures skips this rule. Whether the pictures support the message isn't something we can measure.",
  whitespace: "Balanced spacing: not crowded, and no big empty gaps.",
  clutter: "No busy layout of many small competing pieces, and not overly long.",
  no_decoration:
    "The message is in real text, not only inside pictures: it still works when pictures don't load.",
};

const EXAMPLES: Record<PillarId, string> = {
  accessibility:
    "Text contrast (WCAG AA), alt text that means something, clear link names, tap targets of at least 24px, reading order.",
  mobile:
    "Fits a 375px phone without shrinking, readable column width, big enough buttons, images that adapt, dark-mode resilience.",
  typography:
    "Body text size on phones and desktops, measured line height, line length, alignment, not too many fonts or sizes.",
  hierarchy:
    "A clear primary button in the first screen, visible and clearly labelled, not competing with too many others.",
  images:
    "Not a single big image, key content as live text, images that load, still makes sense with images off.",
  layout:
    "Sensible width, whitespace, clutter, alignment, a disciplined colour palette, consistent components.",
  content:
    "Subject line, the preview text Gmail shows, scannable paragraphs, a length that suits the type of email.",
  technical:
    "Gmail clipping (about 102 KB), compatibility with common email apps, broken links or merge tags, style size.",
  footer:
    "A visible, legible unsubscribe link, preference options, and why you're receiving it. Subscriptions only.",
};

const AI_POINTS: Partial<Record<PillarId, number>> = {
  hierarchy: 6,
  images: 1.5,
  layout: 4,
  content: 2.5,
};

export default function HowWeScorePage() {
  const pillars = Object.keys(PILLAR_WEIGHTS) as PillarId[];
  return (
    <ProsePage
      eyebrow="How it works"
      title="How we judge designs"
      summary="Good, Okay and Bad come from 16 design rules — the Email Design Cheat Sheet from Designmodo's email design guide. Separately, a score out of 100 measures how well the design serves its readers in more detail."
      toc={[
        { id: "verdicts", label: "Good, Okay and Bad" },
        { id: "rules", label: "The 16 rules" },
        { id: "not-checked", label: "Not checked yet" },
        { id: "pillars", label: "The score: nine pillars" },
        { id: "ai", label: "The AI part" },
        { id: "caps", label: "Hard caps" },
        { id: "bands", label: "Score ranges" },
        { id: "coverage", label: "Coverage" },
        { id: "confidence", label: "Confidence & Provisional" },
        { id: "explanations", label: "Explanations" },
        { id: "not-scored", label: "Not part of the score" },
      ]}
    >
      <h2 id="verdicts">Good, Okay and Bad — in plain words</h2>
      <p>
        Every design in the gallery is checked against the same {CHECKLIST_RULE_COUNT} rules, and
        its word follows them strictly:
      </p>
      <ul>
        <li>
          <strong>{VERDICT_LABELS.good}</strong> — it passes every rule. A rule that doesn&apos;t
          apply (like pictures, in an email without any) doesn&apos;t count, but every rule that
          does must be checked and passed.
        </li>
        <li>
          <strong>{VERDICT_LABELS.ok}</strong> — it misses one or two rules, or it misses none but
          we couldn&apos;t check one of them (say, the text is inside a picture, so we can&apos;t
          measure its size).
        </li>
        <li>
          <strong>{VERDICT_LABELS.bad}</strong> — it misses {BAD_MISSES_MIN} or more rules.
        </li>
      </ul>
      <p>
        Each card says how many rules it missed and which. Open a design and “How we judged this”
        shows all {CHECKLIST_RULE_COUNT} rules with a tick or a cross and what we measured for each.
        The gallery&apos;s Problems filter picks designs by the rule they missed.
      </p>

      <h2 id="rules">The {CHECKLIST_RULE_COUNT} rules</h2>
      <ol>
        {CHECKLIST_RULES.map((r) => (
          <li key={r.id}>
            <strong>{r.label}</strong> — {RULE_HOW[r.id]}
          </li>
        ))}
      </ol>

      <h2 id="not-checked">{VERDICT_LABELS.unscored}</h2>
      <p>
        A design needs to be drawn in a real browser and measured before it can be checked, so new
        mail waits for its render. Designs measured before these rules came in (November 2026)
        whose measurements have since been cleared to save space are measured again in the nightly
        run, a batch each night, newest first. The card says when.
      </p>

      <h2 id="pillars">The score: nine pillars, 100 points</h2>
      <p>
        The score is a separate, more detailed measure. It doesn&apos;t decide Good, Okay or Bad;
        you&apos;ll find it in each email&apos;s full analysis, and the gallery can sort and filter
        by it. Every point is earned or lost by a named check with a threshold and a measured value.
        Thresholds come from standards like WCAG where they exist; where they&apos;re a design
        choice, we say so. Credit is graded, not all-or-nothing.
      </p>
      <table>
        <thead>
          <tr>
            <th>Pillar</th>
            <th>Points</th>
            <th>What it looks at</th>
          </tr>
        </thead>
        <tbody>
          {pillars.map((p) => (
            <tr key={p}>
              <td>
                <strong>{PILLAR_LABELS[p]}</strong>
              </td>
              <td>
                {PILLAR_WEIGHTS[p]}
                {AI_POINTS[p] ? (
                  <span className="block text-xs text-subtle-foreground">
                    incl. {AI_POINTS[p]} AI
                  </span>
                ) : null}
              </td>
              <td>{EXAMPLES[p]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        When a check doesn&apos;t apply (say, an email has no button), its points are shared out
        across the other measured checks, so the pillar maximums shift a little — but they always
        add up to 100.
      </p>

      <h2 id="ai">The AI part — at most 14 points</h2>
      <p>
        An AI reviewer (Claude, by Anthropic) rates four things rules can&apos;t measure well:
        visual hierarchy (6 points), polish and consistency (4), copy clarity (2.5) and imagery
        (1.5). It uses a fixed 1–5 rubric, must cite what it saw, and never sees the other
        checks&apos; results. Every AI item is tagged <strong>AI review</strong>. Until a review
        arrives, the score is shown with <strong>AI review pending</strong>.
      </p>

      <h2 id="caps">Hard caps for show-stoppers</h2>
      <p>
        Some problems make an email unusable for many readers, so they cap the score no matter how
        good the rest is:
      </p>
      <table>
        <thead>
          <tr>
            <th>Problem</th>
            <th>Score at most</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Image-only email (blank with images off)</td>
            <td>49</td>
          </tr>
          <tr>
            <td>More than 40% of body text fails contrast</td>
            <td>59</td>
          </tr>
          <tr>
            <td>More than half the images are broken (at least two)</td>
            <td>59</td>
          </tr>
          <tr>
            <td>Not usable on a phone (shrinks to unreadable text)</td>
            <td>64</td>
          </tr>
          <tr>
            <td>Gmail clips it before the main button or more than a quarter of the text</td>
            <td>69</td>
          </tr>
          <tr>
            <td>A visible, unfilled merge tag like *|FNAME|*</td>
            <td>69</td>
          </tr>
        </tbody>
      </table>
      <p>
        Every cap is below 70, and it&apos;s shown as “capped · raw 81” so the pillar points still
        add up. A missing image only counts when the sender&apos;s server says it doesn&apos;t exist
        — a slow or blocked image never does.
      </p>

      <h2 id="bands">Score ranges</h2>
      <p>The full analysis names the score&apos;s range, so you can see how close an email came:</p>
      <div className="my-4 flex flex-wrap gap-2">
        <BandPill band="excellent" />
        <BandPill band="good" />
        <BandPill band="needs_work" />
        <BandPill band="poor" />
      </div>
      <ul>
        <li>
          <strong>Excellent</strong> is 85–100. To get there an email needs a real headline, a main
          button that stands out, pictures (in app and system emails), a designed top and room for
          its text on a phone (an AI rating of 4 out of 5 or better can stand in for all but the
          last); without them the score stops at 84, shown as “held at 84”.
        </li>
        <li>
          <strong>Solid</strong> is 70–84, <strong>Needs work</strong> 50–69 and{" "}
          <strong>Poor</strong> below 50.
        </li>
      </ul>

      <h2 id="coverage">Coverage: how an email was scored</h2>
      <p>Rendering every email in a real browser costs time, so each score says how it was made:</p>
      <ul>
        <li>
          <strong>Own render</strong> — this email was rendered in a sandboxed browser and measured
          directly.
        </li>
        <li>
          <strong>From template</strong> — it closely matches another email from the same sender
          that we rendered, and inherits those measurements (the sample date is shown).
        </li>
        <li>
          <strong>Static checks</strong> — only the email&apos;s code was checked. No number is
          shown (“Design not analysed yet”), just the issues found, with an Analyze button.
        </li>
      </ul>

      <h2 id="confidence">Confidence and “Provisional”</h2>
      <p>
        Confidence is the share of the applicable checks we actually measured: <strong>High</strong>{" "}
        (85%+), <strong>Medium</strong> (70–85%) or <strong>Low</strong>. A score is marked{" "}
        <strong>Provisional</strong> when confidence is low, or when the AI review is pending and
        the score is within 3 points of a band edge.
      </p>

      <h2 id="explanations">Explanations add up</h2>
      <p>
        The “Good” and “Needs improvement” lists come straight from the checks: each item shows what
        we measured, the target, how to fix it, the source, and the points involved. Show-stoppers
        come first, and related problems (like a fixed-width layout that causes several issues) are
        grouped into one item.
      </p>

      <h2 id="not-scored">Not part of the score</h2>
      <ul>
        <li>
          <strong>Sender trust</strong> — authentication, one-click unsubscribe, a postal address —
          is a separate badge.
        </li>
        <li>
          <strong>Tracking</strong> is shown for your information; almost all marketing mail has it.
        </li>
        <li>
          <strong>Fonts</strong>: which fonts an email uses and what each app likely shows are
          informational (they feed a few checks, but add no points of their own).
        </li>
        <li>The image-to-text ratio isn&apos;t scored — the “60/40 rule” is a myth.</li>
      </ul>
    </ProsePage>
  );
}
