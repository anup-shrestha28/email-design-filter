"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { updateSettings } from "@/server/actions/settings";
import type { SettingsData } from "@/server/queries/types";

function Row({
  title,
  description,
  htmlFor,
  children,
}: {
  title: string;
  description: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0 max-w-xl">
        <Label htmlFor={htmlFor} className="text-sm">
          {title}
        </Label>
        <div className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">
          {description}
        </div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * The saved value "UTC" (the column default) means Automatic: dates follow this device's zone
 * (lib/request-context.ts, AUTOMATIC_TIME_ZONE). UTC itself is saved as "Etc/UTC".
 */
const AUTOMATIC = "UTC";
const FIXED_UTC = "Etc/UTC";

export function timeZoneOptions(current: string): Array<{ value: string; label: string }> {
  let all: string[];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = [];
  }
  const zones = all.filter((z) => z !== AUTOMATIC && z !== FIXED_UTC);
  if (current !== AUTOMATIC && current !== FIXED_UTC && !zones.includes(current)) zones.unshift(current);
  return [
    { value: AUTOMATIC, label: "Automatic (this device)" },
    { value: FIXED_UTC, label: "UTC" },
    ...zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") })),
  ];
}

/** Preferences save instantly (each change is its own small update). */
export function Preferences({
  settings,
  role,
}: {
  settings: SettingsData["settings"];
  role: "owner" | "friend";
}) {
  const [values, setValues] = useState(settings);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const zones = useMemo(() => timeZoneOptions(settings.timezone), [settings.timezone]);

  function save<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    const previous = values[key];
    setValues((v) => ({ ...v, [key]: value }));
    startTransition(async () => {
      const r = await updateSettings({ [key]: value });
      if (r.ok) {
        toast.success("Saved");
        // Every date on screen is rendered in the saved zone: re-render so they change now.
        if (key === "timezone") router.refresh();
      } else {
        setValues((v) => ({ ...v, [key]: previous }));
        toast.error(r.error);
      }
    });
  }

  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-surface p-4 shadow-raised sm:p-5">
      <Row
        title="How far back to import"
        description={
          role === "owner"
            ? "Used for the first import of a newly connected mailbox. Longer windows take longer and use more of the free budget."
            : "Invited accounts import the last 30 days, which keeps the shared free budget healthy."
        }
      >
        <SegmentedControl<"30" | "90" | "180">
          aria-label="Import window"
          value={String(values.backfillWindowDays) as "30" | "90" | "180"}
          disabled={role !== "owner"}
          onValueChange={(v) => save("backfillWindowDays", Number(v) as 30 | 90 | 180)}
          options={[
            { value: "30", label: "30 days" },
            { value: "90", label: "90 days" },
            { value: "180", label: "180 days" },
          ]}
        />
      </Row>
      <Row
        htmlFor="pref-images"
        title="Load images for analysis"
        description="Our servers fetch a sender's public images (never trackers or personal images) to measure the design. Turn off for privacy mode: emails are analysed with images off."
      >
        <Switch
          id="pref-images"
          checked={values.loadImagesForAnalysis}
          onCheckedChange={(v) => save("loadImagesForAnalysis", v)}
        />
      </Row>
      <Row
        htmlFor="pref-links"
        title="Check links for broken pages"
        description="Opt in to let us check whether visible links in an email load. We only ever look up domains by default, and never open unsubscribe, sign-in or confirmation links."
      >
        <Switch
          id="pref-links"
          checked={values.linkCheckOptIn}
          onCheckedChange={(v) => save("linkCheckOptIn", v)}
        />
      </Row>
      <Row
        title="Time zone"
        description="Used for Today, deal countdowns and dates. Automatic follows the time zone of the device you're using."
      >
        <Select
          aria-label="Time zone"
          value={values.timezone}
          onValueChange={(v) => save("timezone", v)}
          options={zones}
          className="w-64"
        />
      </Row>
    </div>
  );
}
