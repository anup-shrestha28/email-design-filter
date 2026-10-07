import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Check,
  Eye,
  Fingerprint,
  Lock,
  MailX,
  ScanEye,
  ShieldCheck,
  Sparkles,
  Tag,
  Trash2,
  Type,
  Users,
} from "lucide-react";
import { PillarBars } from "@/components/design/pillar-bars";
import { SenderAvatar } from "@/components/ui/avatar";
import { BandPill } from "@/components/ui/band-pill";
import { LinkButton } from "@/components/ui/button";
import { ScoreBadge } from "@/components/ui/score-badge";
import { ScoreRing } from "@/components/ui/score-ring";
import { TypeChip } from "@/components/ui/type-chip";
import { PILLAR_LABELS, PILLAR_WEIGHTS } from "@/lib/labels";
import type { PillarId } from "@edf/design/types";

export const metadata: Metadata = {
  title: { absolute: "Dearly Mail — your subscriptions, sorted and explained" },
};

const DEMO_PILLARS: Array<{ id: PillarId; points: number; max: number }> = [
  { id: "accessibility", points: 16.9, max: 21.2 },
  { id: "mobile", points: 13.4, max: 15.9 },
  { id: "typography", points: 13.1, max: 15.9 },
  { id: "hierarchy", points: 12.4, max: 15.3 },
  { id: "images", points: 8.8, max: 10.2 },
  { id: "layout", points: 7.6, max: 10.1 },
  { id: "content", points: 3.9, max: 5.1 },
  { id: "technical", points: 4.6, max: 5.3 },
  { id: "footer", points: 0.4, max: 1.0 },
];

const ROWS = [
  {
    name: "Field Notes Weekly",
    domain: "fieldnotes.example",
    subject: "Issue #112: Why small teams ship faster",
    type: "newsletter" as const,
    score: 91,
    band: "excellent" as const,
  },
  {
    name: "Northwind Outfitters",
    domain: "northwind-outfitters.com",
    subject: "30% off everything ends tonight",
    type: "promotional" as const,
    score: 81,
    band: "good" as const,
  },
  {
    name: "Kettle & Crumb",
    domain: "kettleandcrumb.example",
    subject: "YOUR COUPON EXPIRES SOON",
    type: "promotional" as const,
    score: 38,
    band: "poor" as const,
  },
  {
    name: "Parcelly",
    domain: "parcelly.example",
    subject: "Your package is out for delivery",
    type: "transactional" as const,
    score: 74,
    band: "good" as const,
  },
];

const FEATURES = [
  {
    icon: Bell,
    title: "Only what matters surfaces",
    body: "Payment problems, deliveries and security alerts rise to “Needs attention”. Everything else waits quietly.",
  },
  {
    icon: Tag,
    title: "Deals with a clock",
    body: "Discounts and codes are pulled out of promotions, with a live countdown so nothing expires unnoticed.",
  },
  {
    icon: ScanEye,
    title: "Design you can reason about",
    body: "Every designed email gets a 0–100 score from named checks — contrast, phone fit, clipping — with the fix for each.",
  },
  {
    icon: Type,
    title: "Which fonts readers really see",
    body: "Web fonts rarely survive Gmail or Outlook. See the fonts used, and what each email app likely shows instead.",
  },
  {
    icon: ShieldCheck,
    title: "Trust and tracking, in plain view",
    body: "Sender authentication, one-click unsubscribe and tracking pixels are shown — never loaded.",
  },
  {
    icon: Users,
    title: "Clean up senders",
    body: "Find the lists you never open, mute them, or open their unsubscribe page after a safety check.",
  },
];

const PROMISES = [
  { icon: Eye, text: "Read-only Gmail access. We can't send, delete or change anything." },
  {
    icon: MailX,
    text: "Personal mail is never stored. Only the automated mail you signed up for.",
  },
  {
    icon: Lock,
    text: "No email bodies are kept. Emails open live from Gmail in a locked-down viewer.",
  },
  {
    icon: Fingerprint,
    text: "Security emails — codes, password resets — are never rendered or sent to AI.",
  },
  {
    icon: Trash2,
    text: "Disconnect or delete your account at any time, and your data goes with it.",
  },
];

export default function LandingPage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 -top-40 h-[36rem] bg-[radial-gradient(ellipse_55%_50%_at_50%_0%,color-mix(in_oklch,var(--accent)_16%,transparent),transparent)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pt-16 pb-10 text-center sm:px-6 sm:pt-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-xs">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Invite-only beta
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-semibold tracking-[-0.035em] text-balance text-foreground sm:text-6xl">
            Every email design you get, in one gallery — the really good and the really bad.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-pretty text-muted-foreground">
            Connect Gmail read-only and your newsletters, promotions and receipts appear as a wall of
            designs. Each one is marked Good, Okay or Bad, with the reason in plain English. Filter by
            type, by Good or Bad, or by font — that&apos;s it.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <LinkButton href="/sign-in" variant="primary" size="lg">
              Sign in with your invite
              <ArrowRight aria-hidden />
            </LinkButton>
            <LinkButton href="/how-we-score" variant="secondary" size="lg">
              How we judge designs
            </LinkButton>
          </div>
        </div>

        <div className="relative mx-auto max-w-5xl px-4 pb-8 sm:px-6">
          <div
            className="overflow-hidden rounded-2xl border border-border bg-surface shadow-overlay"
            aria-label="Product preview (illustration)"
            role="img"
          >
            <div
              className="flex h-9 items-center gap-1.5 border-b border-border bg-surface-muted/70 px-4"
              aria-hidden
            >
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
              <span className="size-2.5 rounded-full bg-border-strong" />
            </div>
            <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]" aria-hidden>
              <ul className="divide-y divide-border/70 border-border md:border-r">
                {ROWS.map((r, i) => (
                  <li
                    key={r.name}
                    className={`flex gap-3 px-4 py-3 ${i === 1 ? "bg-accent-soft/50" : ""}`}
                  >
                    <SenderAvatar name={r.name} domain={r.domain} />
                    <div className="min-w-0 flex-1 text-left">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[0.8125rem] font-semibold text-foreground">
                          {r.name}
                        </span>
                        <span className="text-xs text-subtle-foreground">
                          {["9:41", "8:02", "Yesterday", "Mon"][i]}
                        </span>
                      </div>
                      <p className="truncate text-[0.8125rem] text-foreground">{r.subject}</p>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <TypeChip type={r.type} size="sm" />
                        <ScoreBadge score={r.score} band={r.band} size="sm" />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="p-5 text-left">
                <div className="flex items-center gap-5">
                  <ScoreRing score={81} band="good" size={104} />
                  <div className="flex flex-col gap-2">
                    <BandPill band="good" />
                    <p className="text-xs text-muted-foreground">Confidence High · Own render</p>
                  </div>
                </div>
                <PillarBars className="mt-5" pillars={DEMO_PILLARS} raw={81.1} />
                <ul className="mt-4 flex flex-col gap-1.5 text-xs">
                  <li className="flex gap-2 text-foreground">
                    <Check className="size-3.5 shrink-0 text-band-excellent" aria-hidden /> Primary
                    button is in the first screen on mobile
                  </li>
                  <li className="flex gap-2 text-foreground">
                    <span className="flex size-3.5 shrink-0 items-center justify-center text-band-poor">
                      ✕
                    </span>{" "}
                    Unsubscribe link is 10px light grey (2.1:1)
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="features">
        <h2
          id="features"
          className="max-w-2xl text-3xl font-semibold tracking-[-0.03em] text-balance text-foreground"
        >
          The mail you signed up for, finally organised
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Eight simple groups — Promotions, Newsletters, Updates, Orders &amp; receipts, Security,
          Notifications, Events and Other — plus smart views like “Deals ending soon” and “Cleanup:
          never opened”.
        </p>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => {
            const Icon = f.icon;
            return (
              <li
                key={f.title}
                className="rounded-2xl border border-border bg-surface p-5 shadow-raised"
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>
                <h3 className="mt-4 text-[0.9375rem] font-semibold text-foreground">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="border-y border-border bg-surface-sunken/60" aria-labelledby="score">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
          <div>
            <h2
              id="score"
              className="text-3xl font-semibold tracking-[-0.03em] text-balance text-foreground"
            >
              A score that shows its working
            </h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              The Design Score isn&apos;t a matter of taste. 86 of its 100 points come from
              measurable checks — WCAG contrast, how it fits a phone, whether Gmail clips it. At
              most 14 come from an AI reviewer judging hierarchy, polish, imagery and copy against a
              fixed rubric, and every AI item is labelled.
            </p>
            <ul className="mt-6 flex flex-col gap-3 text-sm">
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <span className="text-foreground">
                  <strong>The points add up.</strong>{" "}
                  <span className="text-muted-foreground">
                    Pillar by pillar, exactly to the score.
                  </span>
                </span>
              </li>
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <span className="text-foreground">
                  <strong>Broken emails can&apos;t look good.</strong>{" "}
                  <span className="text-muted-foreground">
                    Image-only, unreadable or clipped emails are capped below “Good”.
                  </span>
                </span>
              </li>
              <li className="flex gap-3">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                <span className="text-foreground">
                  <strong>Honest about certainty.</strong>{" "}
                  <span className="text-muted-foreground">
                    Low-confidence scores are marked Provisional instead of guessed.
                  </span>
                </span>
              </li>
            </ul>
            <Link
              href="/how-we-score"
              className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
            >
              Read the full method <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-raised">
            <p className="text-sm font-semibold text-foreground">Nine pillars, 100 points</p>
            <ul className="mt-4 flex flex-col gap-2.5">
              {(Object.keys(PILLAR_WEIGHTS) as PillarId[]).map((p) => (
                <li
                  key={p}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_2rem] items-center gap-3 text-[0.8125rem]"
                >
                  <span className="truncate text-foreground">{PILLAR_LABELS[p]}</span>
                  <span
                    className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
                    aria-hidden
                  >
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${PILLAR_WEIGHTS[p] * 5}%` }}
                    />
                  </span>
                  <span className="tabular text-right text-xs text-muted-foreground">
                    {PILLAR_WEIGHTS[p]}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4 text-xs">
              <BandPill band="excellent" size="sm" />
              <BandPill band="good" size="sm" />
              <BandPill band="needs_work" size="sm" />
              <BandPill band="poor" size="sm" />
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6" aria-labelledby="privacy">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h2
              id="privacy"
              className="text-3xl font-semibold tracking-[-0.03em] text-balance text-foreground"
            >
              Private by design
            </h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Built for one person and a few friends — not for advertisers. Nobody reads your mail,
              and nothing is sold.
            </p>
            <div className="mt-6 space-y-3 rounded-xl border border-border bg-surface p-4 text-xs leading-relaxed text-muted-foreground">
              <p>
                The use of information received from Google Workspace scopes will adhere to the
                Google User Data Policy, including the Limited Use requirements.
              </p>
              <p>
                Dearly Mail&apos;s use and transfer of information received from Google APIs
                will adhere to the Google API Services User Data Policy, including the Limited Use
                requirements.
              </p>
              <Link
                href="/privacy"
                className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
              >
                Privacy policy <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </div>
          </div>
          <ul className="flex flex-col gap-3">
            {PROMISES.map((p) => {
              const Icon = p.icon;
              return (
                <li
                  key={p.text}
                  className="flex items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-raised"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-success-soft text-success">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <p className="text-sm text-foreground">{p.text}</p>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="relative overflow-hidden rounded-3xl bg-inverse px-6 py-14 text-center sm:px-12">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_80%_at_50%_120%,color-mix(in_oklch,var(--accent)_45%,transparent),transparent)]"
          />
          <h2 className="relative text-3xl font-semibold tracking-[-0.03em] text-inverse-foreground">
            Got an invite?
          </h2>
          <p className="relative mx-auto mt-3 max-w-lg text-inverse-foreground/70">
            Sign in with the Google account your invite was sent to. Connecting Gmail is a separate
            step, explained before anything happens.
          </p>
          <LinkButton href="/sign-in" variant="secondary" size="lg" className="relative mt-7">
            Sign in
            <ArrowRight aria-hidden />
          </LinkButton>
        </div>
      </section>
    </>
  );
}
