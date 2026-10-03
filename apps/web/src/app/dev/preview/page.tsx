import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DesignPanel } from "@/components/design/design-panel";
import { FontsCard } from "@/components/design/fonts-card";
import { EmailViewer } from "@/components/email/email-viewer";
import { AppProviders } from "@/components/providers/app-providers";
import { ThemeScript } from "@/components/shell/theme-script";
import { SenderAvatar } from "@/components/ui/avatar";
import { BandPill } from "@/components/ui/band-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CoverageLabel } from "@/components/ui/coverage-label";
import { DealCountdown } from "@/components/ui/deal-countdown";
import { EmptyState } from "@/components/ui/empty-state";
import { ImportanceDot } from "@/components/ui/importance-dot";
import { KeyCombo } from "@/components/ui/kbd";
import { MeterBar, ProgressBar } from "@/components/ui/progress";
import { ScoreBadge } from "@/components/ui/score-badge";
import { ScoreRing } from "@/components/ui/score-ring";
import { Sparkline } from "@/components/ui/sparkline";
import { TrustBadge } from "@/components/ui/trust-badge";
import { TypeChip } from "@/components/ui/type-chip";
import { requestContext } from "@/lib/request-context";
import { TYPE_GROUP_ORDER } from "@/lib/labels";
import { Inbox } from "lucide-react";
import { KitControls } from "./kit-controls";
import { DESIGN_STATES, MOCK_ACTIONS } from "./mocks";

export const metadata: Metadata = { title: "Component preview (dev)" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2 border-b border-border py-4 last:border-b-0 md:grid-cols-[12rem_1fr] md:items-center">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-2.5">{children}</div>
    </div>
  );
}

/** DEVELOPMENT ONLY: every Design/Fonts state and the component kit, from typed mocks. */
export default async function DevPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  const { nonce, clock } = await requestContext();
  const inTwoHours = new Date(clock.serverNow + 2 * 3_600_000).toISOString();
  const inThreeDays = new Date(clock.serverNow + 3 * 86_400_000).toISOString();
  return (
    <>
      <ThemeScript nonce={nonce} />
      <AppProviders clock={clock}>
        <main className="mx-auto max-w-7xl px-4 py-10 sm:px-8">
          <p className="text-xs font-medium tracking-wide text-warning uppercase">
            Development only
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em]">Component preview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Typed mocks for every Design Score and Fonts state (the seeded demo only carries
            summaries).
          </p>

          <Card className="mt-8">
            <CardHeader>
              <CardTitle>Kit</CardTitle>
            </CardHeader>
            <CardContent>
              <Row label="Buttons">
                <Button variant="primary">Primary</Button>
                <Button>Secondary</Button>
                <Button variant="soft">Soft</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="danger">Danger</Button>
                <Button variant="primary" loading>
                  Saving
                </Button>
                <Button size="sm">Small</Button>
                <Button size="xs">Extra small</Button>
              </Row>
              <Row label="Score badges">
                <ScoreBadge score={92} band="excellent" />
                <ScoreBadge score={78} band="good" />
                <ScoreBadge score={61} band="needs_work" />
                <ScoreBadge score={38} band="poor" />
                <ScoreBadge score={59} band="needs_work" capped />
                <ScoreBadge score={68} band="needs_work" provisional />
                <ScoreBadge score={null} band={null} />
                <ScoreBadge score={null} band={null} status="plain_text" />
                <ScoreBadge score={null} band={null} status="skipped" />
                <ScoreBadge score={81} band="good" size="lg" />
              </Row>
              <Row label="Band pills">
                <BandPill band="excellent" />
                <BandPill band="good" />
                <BandPill band="needs_work" />
                <BandPill band="poor" />
                <BandPill band="good" provisional />
              </Row>
              <Row label="Score rings">
                <ScoreRing score={92} band="excellent" size={96} />
                <ScoreRing score={59} raw={81} band="needs_work" size={96} />
                <ScoreRing score={68} band="needs_work" provisional size={96} />
              </Row>
              <Row label="Type chips">
                {TYPE_GROUP_ORDER.map((g) => (
                  <TypeChip key={g} group={g} />
                ))}
              </Row>
              <Row label="Signals">
                <ImportanceDot level="high" />
                <ImportanceDot level="low" />
                <DealCountdown endsAt={inTwoHours} hasCode />
                <DealCountdown endsAt={inThreeDays} />
                <DealCountdown endsAt={null} />
                <TrustBadge state="trusted" />
                <TrustBadge state="partial" missing={["postal_address"]} />
                <TrustBadge state="failed_auth" />
              </Row>
              <Row label="Coverage">
                <CoverageLabel coverage="render" />
                <CoverageLabel coverage="template" sampleDate="2026-09-12T09:30:00.000Z" />
                <CoverageLabel coverage="static" />
              </Row>
              <Row label="Badges, keys, avatars">
                <Badge>Neutral</Badge>
                <Badge tone="accent">Accent</Badge>
                <Badge tone="success">Success</Badge>
                <Badge tone="warning">Warning</Badge>
                <Badge tone="danger">Danger</Badge>
                <KeyCombo keys="g i" />
                <KeyCombo keys="⌘ K" />
                <SenderAvatar name="Northwind Outfitters" domain="northwind-outfitters.com" />
                <SenderAvatar name="Field Notes Weekly" domain="fieldnotes.example" />
                <SenderAvatar name="Kettle & Crumb" domain="kettleandcrumb.example" />
                <Sparkline values={[72, 75, 71, null, 80, 84, 82]} label="Design trend" />
              </Row>
              <Row label="Progress & meters">
                <div className="grid w-full max-w-md gap-3">
                  <ProgressBar value={62} label="Import progress" />
                  <ProgressBar value={null} label="Import starting" />
                  <MeterBar value={3.1} max={4.5} label="AI spend" />
                  <MeterBar value={4.2} max={4.5} label="AI spend near cap" />
                </div>
              </Row>
              <KitControls />
              <EmptyState
                icon={<Inbox />}
                title="Nothing matches these filters"
                description="Try removing a filter or two."
                size="sm"
              />
            </CardContent>
          </Card>

          <h2 className="mt-12 text-lg font-semibold tracking-[-0.015em]">Email viewer</h2>
          <div className="mt-4 grid gap-5 lg:grid-cols-2">
            <EmailViewer viewer={null} layout={null} />
            <EmailViewer
              viewer={{
                src: "http://localhost:3001/v/dev.0.sig/00000000-0000-4000-8000-000000000000",
                srcImagesOff:
                  "http://localhost:3001/v/dev.0.sig/00000000-0000-4000-8000-000000000000",
                expiresAt: inTwoHours,
              }}
              layout={{ desktopHeight: 900, mobileHeight: 1200 }}
            />
          </div>

          {DESIGN_STATES.map((s) => (
            <section key={s.id} id={s.id} className="mt-12">
              <h2 className="text-lg font-semibold tracking-[-0.015em]">{s.title}</h2>
              <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
                <DesignPanel
                  emailId="00000000-0000-4000-8000-000000000000"
                  design={s.design}
                  actions={MOCK_ACTIONS}
                />
                <FontsCard fonts={s.fonts} sampleDate={s.design.renderRef?.renderedAt ?? null} />
              </div>
            </section>
          ))}
        </main>
      </AppProviders>
    </>
  );
}
