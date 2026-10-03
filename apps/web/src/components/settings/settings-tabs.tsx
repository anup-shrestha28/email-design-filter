"use client";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import type { ReactNode } from "react";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";

const TABS = ["mailboxes", "preferences", "ai", "invites", "data"] as const;
type TabId = (typeof TABS)[number];

const LABELS: Record<TabId, string> = {
  mailboxes: "Mailboxes",
  preferences: "Preferences",
  ai: "AI usage",
  invites: "Invites",
  data: "Data & account",
};

/** Settings sections as tabs; the open tab is kept in the URL (?tab=…). */
export function SettingsTabs({ panels }: { panels: Partial<Record<TabId, ReactNode>> }) {
  const available = TABS.filter((t) => panels[t] !== undefined);
  const [tab, setTab] = useQueryState(
    "tab",
    parseAsStringLiteral(TABS)
      .withDefault("mailboxes")
      .withOptions({ clearOnDefault: true, scroll: false }),
  );
  const current = available.includes(tab) ? tab : "mailboxes";
  return (
    <Tabs value={current} onValueChange={(v) => void setTab(v as TabId)}>
      <TabsList className="mb-6">
        {available.map((t) => (
          <Tab key={t} value={t}>
            {LABELS[t]}
          </Tab>
        ))}
      </TabsList>
      {available.map((t) => (
        <TabsPanel key={t} value={t}>
          {panels[t]}
        </TabsPanel>
      ))}
    </Tabs>
  );
}
