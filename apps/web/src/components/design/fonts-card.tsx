import type { FontProfile } from "@edf/design/types";
import { ImageIcon, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Time } from "@/components/ui/time";
import { cn } from "@/lib/cn";
import { formatPercent } from "@/lib/format";
import { CLIENT_LABELS, FONT_CLASS_LABELS, FONT_ROLE_LABELS } from "@/lib/labels";

const CLASS_TONE = {
  web: "accent",
  likely_web: "info",
  system: "neutral",
  not_loaded: "warning",
} as const;

function sourceNote(fonts: FontProfile, sampleDate: string | null) {
  if (fonts.source === "static") return "Fonts declared in the email code (not measured)";
  if (fonts.source === "template") {
    return sampleDate ? (
      <>
        Measured on the template sample (<Time iso={sampleDate} variant="short" />)
      </>
    ) : (
      "Measured on the template sample"
    );
  }
  if (fonts.source === "summary") return "Saved summary";
  return "Measured from this email's render";
}

/** Fonts card (DESIGN.md §8.1): families, roles, share, class, weights, what each app likely shows. */
export function FontsCard({
  fonts,
  sampleDate = null,
  className,
}: {
  fonts: FontProfile | null;
  sampleDate?: string | null;
  className?: string;
}) {
  if (!fonts) {
    return (
      <Card className={className}>
        <CardHeader>
          <div>
            <CardTitle>Fonts</CardTitle>
            <CardDescription>No font profile for this email.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            Security emails, plain-text emails and emails that couldn&apos;t be rendered have no
            font profile.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className={cn("@container", className)}>
      <CardHeader>
        <div>
          <CardTitle>Fonts</CardTitle>
          <CardDescription>{sourceNote(fonts, sampleDate)}</CardDescription>
        </div>
        {fonts.usesWebFonts ? (
          <Badge tone="accent" size="sm">
            Uses web fonts
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          {fonts.families.map((f) => (
            <li key={f.name} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-foreground">
                  {f.name}
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={CLASS_TONE[f.class]} size="sm">
                    {FONT_CLASS_LABELS[f.class]}
                  </Badge>
                  {f.provider ? (
                    <span className="text-xs text-muted-foreground">{f.provider}</span>
                  ) : null}
                </span>
              </div>
              {f.share !== null ? (
                <div className="flex items-center gap-3">
                  <span
                    className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border/50"
                    aria-hidden
                  >
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-accent"
                      style={{ width: `${Math.max(2, f.share * 100)}%` }}
                    />
                  </span>
                  <span className="tabular w-24 shrink-0 text-right text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{formatPercent(f.share)}</span> of
                    text
                  </span>
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {f.roles.length ? (
                  <span>{f.roles.map((r) => FONT_ROLE_LABELS[r]).join(" · ")}</span>
                ) : null}
                {f.roles.length && (f.weights.length || f.weightNote) ? (
                  <span aria-hidden> · </span>
                ) : null}
                {f.weights.length ? (
                  <span>
                    weights{" "}
                    {f.weights.map((w, i) => (
                      <span key={w.weight}>
                        {i > 0 ? ", " : ""}
                        <span className={w.synthesized ? "text-warning" : undefined}>
                          {w.weight}
                          {w.synthesized ? " (synthesized)" : ""}
                        </span>
                      </span>
                    ))}
                  </span>
                ) : null}
                {f.weightNote ? (
                  <span>
                    {f.weights.length ? " · " : ""}
                    {f.weightNote}
                  </span>
                ) : null}
              </p>
            </li>
          ))}
          {fonts.noFontSetShare !== null && fonts.noFontSetShare > 0 ? (
            <li className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>No font set (each app&apos;s default)</span>
              <span className="tabular">{formatPercent(fonts.noFontSetShare)} of text</span>
            </li>
          ) : null}
        </ul>

        {fonts.fallbacks.length ? (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Backups:</span>{" "}
            {fonts.fallbacks.join(", ")}
          </p>
        ) : null}

        {fonts.warnings.length ? (
          <ul className="flex flex-col gap-2">
            {fonts.warnings.map((w) => (
              <li
                key={w}
                className="flex gap-2 rounded-lg bg-warning-soft/70 p-2.5 text-xs leading-relaxed text-foreground"
              >
                <TriangleAlert
                  className="mt-px size-3.5 shrink-0 text-warning"
                  aria-label="Warning"
                />
                {w}
              </li>
            ))}
          </ul>
        ) : null}

        {fonts.clients.length ? (
          <div>
            <h3 className="mb-1.5 text-xs font-semibold text-foreground">
              What readers likely see
            </h3>
            <table className="w-full text-xs">
              <caption className="sr-only">Likely main text font per email app</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Email app</th>
                  <th scope="col">Likely font</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {fonts.clients.map((c) => (
                  <tr key={c.client} title={c.note || undefined}>
                    <th
                      scope="row"
                      className="py-1.5 pr-3 text-left font-normal text-muted-foreground"
                    >
                      {c.label || CLIENT_LABELS[c.client]}
                    </th>
                    <td className="py-1.5 text-right">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 font-medium",
                          c.warning ? "text-warning" : "text-foreground",
                        )}
                      >
                        {c.warning ? (
                          <TriangleAlert className="size-3" aria-label="Warning" />
                        ) : null}
                        {c.likely}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1.5 text-2xs text-subtle-foreground">
              “Likely” — it depends on the device and installed fonts.
            </p>
          </div>
        ) : null}

        {fonts.declaredUnused.length ? (
          <p className="text-xs text-subtle-foreground">
            Loaded but not used: {fonts.declaredUnused.join(", ")}
          </p>
        ) : null}
        {fonts.imageTextCount ? (
          <p className="flex items-center gap-1.5 text-xs text-subtle-foreground">
            <ImageIcon className="size-3.5" aria-hidden />
            At least {fonts.imageTextCount}{" "}
            {fonts.imageTextCount === 1 ? "image contains" : "images contain"} text — fonts inside
            images can&apos;t be identified.
          </p>
        ) : null}
        {fonts.source === "static" ? (
          <p className="flex gap-1.5 text-xs leading-relaxed text-subtle-foreground">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            Shares, roles and per-app results appear once the email is rendered.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
