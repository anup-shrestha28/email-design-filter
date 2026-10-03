import { Eye, Lock, MailCheck, ShieldCheck, Trash2 } from "lucide-react";
import { LinkButton } from "@/components/ui/button";

const POINTS = [
  {
    icon: Eye,
    title: "Read-only",
    body: "We can't send, delete or change anything in your Gmail.",
  },
  {
    icon: MailCheck,
    title: "Only automated mail",
    body: "Newsletters, promotions, receipts and alerts. Personal mail is never stored.",
  },
  {
    icon: Lock,
    title: "No email bodies kept",
    body: "Emails open live from Gmail in a locked-down viewer.",
  },
  {
    icon: Trash2,
    title: "Leave any time",
    body: "Disconnect in Settings and your data is deleted.",
  },
];

/** Onboarding: nothing connected yet. */
export function ConnectCard() {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-border bg-surface shadow-raised">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -right-24 size-72 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--accent)_22%,transparent),transparent)]"
      />
      <div className="relative grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.1fr_1fr] lg:items-center">
        <div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent-soft-foreground">
            <ShieldCheck className="size-3.5" aria-hidden />
            Step 1 of 1
          </span>
          <h2 className="mt-4 text-2xl font-semibold tracking-[-0.025em] text-balance text-foreground">
            Connect your Gmail to get started
          </h2>
          <p className="mt-2 max-w-md text-[0.9375rem] leading-relaxed text-muted-foreground">
            We&apos;ll sort the mail you signed up for — newsletters, deals, receipts, security
            alerts — and score how well each designed email works on phones, with images off, and
            for every reader.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <LinkButton href="/connect" variant="primary" size="lg">
              Connect Gmail
            </LinkButton>
            <span className="text-xs text-muted-foreground">
              Takes about a minute. The first import runs in the background.
            </span>
          </div>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {POINTS.map((p) => {
            const Icon = p.icon;
            return (
              <li
                key={p.title}
                className="rounded-xl border border-border bg-surface-muted/60 p-3.5"
              >
                <Icon className="size-4 text-accent" aria-hidden />
                <p className="mt-2 text-[0.8125rem] font-medium text-foreground">{p.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
