import type { Metadata } from "next";
import type { PillarId } from "@edf/design/types";
import { BandPill } from "@/components/ui/band-pill";
import { ProsePage } from "@/components/site/site-chrome";
import {
  COMPETING_BUTTONS_MIN,
  GALLERY_PROBLEM_LABELS,
  GMAIL_CLIP_KB,
  GOOD_SCORE_MIN,
  HEADLINE_RATIO_MIN,
  HERO_BAND_CONTRAST_MIN,
  HERO_PICTURE_AREA_MIN,
  HERO_PICTURE_WIDTH_MIN,
  IMAGE_TEXT_CHARS_MAX,
  IMAGE_TEXT_SHARE_MIN,
  IMAGERY_SHARE_MIN,
  PHONE_PROBLEM_SHARE,
  POOR_SCORE_MAX,
  SHRINK_K_MAX,
  TINY_PHONE_TEXT_PX,
  VERDICT_LABELS,
} from "@/lib/gallery";
import { CONTRAST_CAP_SHARE, GATE_CEILING } from "@/lib/gallery-evidence";
import { PILLAR_LABELS, PILLAR_WEIGHTS } from "@/lib/labels";

export const metadata: Metadata = { title: "How we judge designs" };

/** A share as a whole percentage (0.08 → 8). */
const pct = (share: number) => Math.round(share * 100);

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
      summary="The score measures how well an email's design serves its readers — can they read it, use it on a phone, understand what it wants, and act on it — whatever app they use, with images on or off. It is not a measure of taste."
      toc={[
        { id: "verdicts", label: "Good, Okay and Bad" },
        { id: "pillars", label: "Nine pillars" },
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
        Every design in the gallery gets one of three words. We keep them strict on purpose: Good
        means <em>really</em> good, and Bad means <em>really</em> bad.
      </p>

      <h3>{VERDICT_LABELS.good}</h3>
      <p>An email is a Good design only when all of this is true:</p>
      <ul>
        <li>It scores {GOOD_SCORE_MIN} or more out of 100.</li>
        <li>It has none of the Bad problems below.</li>
        <li>
          We scored it from a real render — the email drawn in a browser, or a near-identical email
          from the same sender — and measured enough of it to be sure.
        </li>
        <li>
          It clears every Good bar:
          <ul>
            <li>
              <strong>A real headline</strong> — heading text at least {HEADLINE_RATIO_MIN}× the
              size of the body text. A big button or menu label doesn&apos;t count.
            </li>
            <li>
              <strong>A main button that stands out</strong> — a filled button in a colour that
              stands out, sitting on the first phone screen or being the most eye-catching link in
              the email. If {COMPETING_BUTTONS_MIN} or more buttons look the same and lead to{" "}
              {COMPETING_BUTTONS_MIN} or more different places, none of them is the main one.
            </li>
            <li>
              <strong>Pictures</strong>, in app and system emails (every kind except sales,
              product-update and event emails) — pictures cover at least {pct(IMAGERY_SHARE_MIN)}%
              of the email.
            </li>
            <li>
              <strong>A designed top</strong> — a real picture at least {HERO_PICTURE_WIDTH_MIN} px
              wide and {HERO_PICTURE_AREA_MIN.toLocaleString("en-US")} px² in size (say 400 × 100; a
              logo, avatar or row of icons is smaller), or a large headline on a coloured band,
              panel or dark background (at least {HERO_BAND_CONTRAST_MIN}:1 against white, so a
              barely-there tint doesn&apos;t count). A logo, a plain headline on white, a few lines
              and a button is a stock template look, however clean.
            </li>
            <li>
              <strong>Room on a phone</strong> — less than {pct(PHONE_PROBLEM_SHARE)}% of the text
              is squeezed into narrow columns, and less than {pct(PHONE_PROBLEM_SHARE)}% runs right
              to the screen edge.
            </li>
          </ul>
        </li>
      </ul>
      <p>
        When our AI reviewer rates the visual hierarchy, polish or pictures 4 out of 5 or better,
        that stands in for the first four bars — never for room on a phone. Pictures that
        didn&apos;t load for us never count toward Good: if most of them didn&apos;t load, the
        picture bar can&apos;t pass, and a picture that didn&apos;t load can&apos;t be the designed
        top. When we skip loading an email&apos;s pictures on purpose (receipts and account mail,
        suspicious mail, privacy mode), those two bars aren&apos;t judged.
      </p>

      <h3>{VERDICT_LABELS.bad}</h3>
      <p>
        Any one of these makes an email Bad, however good the rest is. Each one is an option in the
        gallery&apos;s Problems filter:
      </p>
      <ul>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.clipped}</strong> — it&apos;s over {GMAIL_CLIP_KB} KB, so
          Gmail cuts it off (readers see “[Message clipped]”), and the cut hides the main button,
          the unsubscribe link or more than a quarter of the text.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.image_only}</strong> — pictures cover at least{" "}
          {pct(IMAGE_TEXT_SHARE_MIN)}% of it and it has fewer than {IMAGE_TEXT_CHARS_MAX} characters
          of real text (a description for screen readers doesn&apos;t change that). Pictures that
          didn&apos;t load for us don&apos;t count against the sender: when most of the picture area
          didn&apos;t load, we don&apos;t judge this. One exception: if none of its pictures showed
          and it has fewer than {IMAGE_TEXT_CHARS_MAX} characters of real text, it&apos;s Bad anyway
          — like one huge poster too big to load, it leaves almost nothing to read.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.mobile}</strong> — to fit a phone, the layout shrinks
          below {pct(SHRINK_K_MAX)}% of its size and its text ends up smaller than{" "}
          {TINY_PHONE_TEXT_PX} px. Also when it&apos;s broken on phones outright: you have to scroll
          sideways, or the text or the main button shrinks far too small to read or tap.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.no_unsubscribe}</strong> — a promotional email with no
          unsubscribe link anywhere. Only promotional emails (Promotions and Abandoned cart) are
          judged on this; receipts, sign-in codes, account notices and app notifications don&apos;t
          need one. We go by the email&apos;s type as the gallery shows it, so if you correct the
          type, the verdict follows.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.contrast}</strong> — more than {pct(CONTRAST_CAP_SHARE)}%
          of the headline and body text is too faint to read against its background.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.broken_images}</strong> — most of its pictures are
          missing: at least two, and the sender&apos;s server says they don&apos;t exist or
          aren&apos;t pictures. A slow or blocked picture never counts.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.merge_tag}</strong> — it shows raw placeholder code, like
          “Hi {"{{first_name}}"}”, in the subject or at the top of the email.
        </li>
        <li>
          <strong>{GALLERY_PROBLEM_LABELS.low_score}</strong> — no single fatal flaw, but lots of
          smaller problems add up to a score under {POOR_SCORE_MAX}.
        </li>
      </ul>

      <h3>{VERDICT_LABELS.ok}</h3>
      <p>
        Everything in between: no Bad problem, but not Good either. Open one and “How we judged
        this” says exactly why it isn&apos;t Good:
      </p>
      <ul>
        <li>
          it misses one of the Good bars — say, “No real headline (the biggest text is 1.1× the body
          text; Good needs {HEADLINE_RATIO_MIN}×)”. Missing a bar holds the score at {GATE_CEILING}{" "}
          or below, so the number and the word always agree;
        </li>
        <li>
          its score is under {GOOD_SCORE_MIN} ({POOR_SCORE_MAX}–{GOOD_SCORE_MIN - 1}): smaller
          problems add up;
        </li>
        <li>or we couldn&apos;t see or measure enough of it to be sure.</li>
      </ul>
      <p>
        A plain layout that doesn&apos;t resize for phones but keeps at least {pct(SHRINK_K_MAX)}%
        of its size, or keeps its text at {TINY_PHONE_TEXT_PX} px or more, is Okay, not Bad; so is
        an email just over Gmail&apos;s size limit whose cut hides nothing that matters.
      </p>
      <p>
        Each card says why in one line you can check by looking at the email, and the detail view
        lists up to three things that work and three that could be better.
      </p>

      <p>
        Every point is earned or lost by a named check with a threshold and a measured value.
        Thresholds come from standards like WCAG where they exist; where they&apos;re a design
        choice, we say so. Credit is graded, not all-or-nothing.
      </p>

      <h2 id="pillars">Nine pillars, 100 points</h2>
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
        Any of these makes an email a <strong>Bad design</strong>, whatever else it does well. Every
        cap is below 70, and it&apos;s shown as “capped · raw 81” so the pillar points still add up.
        A missing image only counts when the sender&apos;s server says it doesn&apos;t exist — a
        slow or blocked image never does.
      </p>

      <h2 id="bands">Score ranges</h2>
      <p>
        Behind the three words is a score out of 100. The full analysis also names its range, so you
        can see how close an email came:
      </p>
      <div className="my-4 flex flex-wrap gap-2">
        <BandPill band="excellent" />
        <BandPill band="good" />
        <BandPill band="needs_work" />
        <BandPill band="poor" />
      </div>
      <ul>
        <li>
          <strong>Excellent</strong> is 85–100. To get there an email must clear every Good bar
          above (an AI rating of 4 out of 5 or better can stand in for all but room on a phone).
          Without them the score stops at {GATE_CEILING}, shown as “held at {GATE_CEILING}”. An
          Excellent email with none of the Bad problems, scored from a real render and measured well
          enough, is a <strong>Good design</strong>.
        </li>
        <li>
          <strong>Solid</strong> (70–84) and the top of <strong>Needs work</strong> (60–69) are{" "}
          <strong>Okay</strong> in the gallery, unless one of the Bad problems above makes them Bad.
        </li>
        <li>
          A score under 60 — <strong>Poor</strong> (below 50) or the bottom of Needs work (50–59) —
          is always a <strong>Bad design</strong>, as is any capped email.
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
        the score is within 3 points of a band edge. A design we couldn&apos;t fully measure is
        never called a Good design until it firms up. Provisional doesn&apos;t protect a Bad one: a
        serious problem (a cap) is a fact the AI review can&apos;t change, so it&apos;s Bad either
        way. Being unsure what <em>kind</em> of email it is (say, newsletter or promotion) says
        nothing about its design and doesn&apos;t block Good.
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
