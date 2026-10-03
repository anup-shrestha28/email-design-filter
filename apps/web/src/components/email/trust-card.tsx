import type { AuthVerdict } from "@edf/core/types";
import { Check, Minus, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TrustBadge, trustSummary } from "@/components/ui/trust-badge";
import { cn } from "@/lib/cn";
import { AUTH_VERDICT_LABELS } from "@/lib/labels";
import type { EmailDetail } from "@/server/queries/types";

function Verdict({ v }: { v: AuthVerdict | null }) {
  if (!v) return <span className="text-subtle-foreground">—</span>;
  const good = v === "pass";
  const bad = v === "fail" || v === "softfail" || v === "permerror";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        good ? "text-success" : bad ? "text-danger" : "text-muted-foreground",
      )}
    >
      {good ? (
        <Check className="size-3.5" aria-hidden />
      ) : bad ? (
        <X className="size-3.5" aria-hidden />
      ) : (
        <Minus className="size-3.5" aria-hidden />
      )}
      {AUTH_VERDICT_LABELS[v]}
    </span>
  );
}

function YesNo({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-subtle-foreground">Not applicable</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-medium",
        value ? "text-success" : "text-muted-foreground",
      )}
    >
      {value ? <Check className="size-3.5" aria-hidden /> : <X className="size-3.5" aria-hidden />}
      {value ? "Yes" : "No"}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-[0.8125rem]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}

/** Sender trust & compliance (separate from the design score) and tracking — information, not a filter. */
export function TrustCard({ detail }: { detail: EmailDetail }) {
  const t = detail.trust;
  const pixels = t?.tracking.pixels ?? detail.trackerCount;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Trust &amp; tracking</CardTitle>
          <CardDescription>Not part of the design score.</CardDescription>
        </div>
        {t ? <TrustBadge state={t.state} missing={t.missing} size="sm" /> : null}
      </CardHeader>
      <CardContent>
        {t && t.state !== "trusted" ? (
          <p
            className={cn(
              "mb-2 rounded-md px-2.5 py-2 text-xs",
              t.state === "failed_auth"
                ? "bg-danger-soft text-danger"
                : "bg-warning-soft text-warning",
            )}
          >
            {trustSummary(t.state, t.missing)}
          </p>
        ) : null}
        <dl className="divide-y divide-border">
          <Row label="DMARC">
            <Verdict v={t?.dmarc ?? detail.auth.dmarc} />
          </Row>
          <Row label="SPF">
            <Verdict v={t?.spf ?? null} />
          </Row>
          <Row label="DKIM">
            <Verdict v={t?.dkim ?? null} />
          </Row>
          <Row label="One-click unsubscribe">
            <YesNo value={t ? t.oneClick : detail.unsubscribe.oneClick} />
          </Row>
          <Row label="Visible unsubscribe link">
            <YesNo value={t?.visibleUnsubscribe ?? null} />
          </Row>
          <Row label="Postal address">
            <YesNo value={t?.postalAddress ?? null} />
          </Row>
        </dl>
        <h3 className="mt-4 mb-1 text-xs font-semibold text-foreground">Tracking</h3>
        <dl className="divide-y divide-border">
          <Row label="Tracking pixels">
            <span className="tabular font-medium text-foreground">{pixels}</span>
          </Row>
          <Row label="Click trackers">
            <span className="text-foreground">
              {t?.tracking.clickTrackerHosts.length
                ? t.tracking.clickTrackerHosts.join(", ")
                : "None found"}
            </span>
          </Row>
          {(t?.tracking.utmCampaign ?? detail.utmCampaign) ? (
            <Row label="Campaign tag">
              <code className="font-mono text-xs text-foreground">
                {t?.tracking.utmCampaign ?? detail.utmCampaign}
              </code>
            </Row>
          ) : null}
        </dl>
        <p className="mt-2 text-2xs leading-relaxed text-subtle-foreground">
          We never load tracking pixels. Almost all marketing mail has them, so this is shown for
          information only.
        </p>
      </CardContent>
    </Card>
  );
}
