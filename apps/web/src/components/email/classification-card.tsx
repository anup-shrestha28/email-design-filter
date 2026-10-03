import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TypeChip } from "@/components/ui/type-chip";
import { formatPercent } from "@/lib/format";
import { subtypeLabel, TYPE_SOURCE_LABELS } from "@/lib/labels";
import { TYPE_LABELS } from "@/lib/types-display";
import type { EmailDetail } from "@/server/queries/types";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[0.8125rem]">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-foreground">{children}</dd>
    </div>
  );
}

/** How the email was classified and why (type, subtype, source, confidence, subscription). */
export function ClassificationCard({ detail }: { detail: EmailDetail }) {
  const c = detail.classification;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Classification</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <Row label="Type">
            <TypeChip type={c.primaryType} />
          </Row>
          {c.subtype ? <Row label="Kind">{subtypeLabel(c.subtype)}</Row> : null}
          <Row label="Decided by">{TYPE_SOURCE_LABELS[c.typeSource]}</Row>
          {c.typeConfidence !== null ? (
            <Row label="Confidence">{formatPercent(c.typeConfidence)}</Row>
          ) : null}
          <Row label="Subscription">
            {c.isSubscription ? "Yes" : "No"}
            {c.subscriptionScore !== null ? (
              <span className="text-subtle-foreground">
                {" "}
                · score {Math.round(c.subscriptionScore)}
              </span>
            ) : null}
          </Row>
          {c.secondaryTags.length ? (
            <Row label="Also">
              {c.secondaryTags
                .map((t) => TYPE_LABELS[t as keyof typeof TYPE_LABELS] ?? t)
                .join(", ")}
            </Row>
          ) : null}
          {detail.gmailCategory ? (
            <Row label="Gmail tab">
              {detail.gmailCategory[0]?.toUpperCase() + detail.gmailCategory.slice(1)}
            </Row>
          ) : null}
          {detail.espPlatform ? <Row label="Sent with">{detail.espPlatform}</Row> : null}
          {detail.language ? <Row label="Language">{detail.language.toUpperCase()}</Row> : null}
          <Row label="Mailbox">
            <span className="break-all">{detail.mailboxAddress}</span>
          </Row>
        </dl>
      </CardContent>
    </Card>
  );
}
