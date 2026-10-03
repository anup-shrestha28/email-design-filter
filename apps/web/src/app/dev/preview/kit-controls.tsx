"use client";
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { MultiCombobox } from "@/components/ui/combobox";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tab, Tabs, TabsList, TabsPanel } from "@/components/ui/tabs";

const FONTS = [
  { value: "montserrat", label: "Montserrat", count: 41 },
  { value: "inter", label: "Inter", count: 37 },
  { value: "georgia", label: "Georgia", count: 22 },
  { value: "arial", label: "Arial", count: 19 },
];

/** DEVELOPMENT ONLY: interactive kit controls. */
export function KitControls() {
  const [scope, setScope] = useState<"subscriptions" | "receipts" | "all">("subscriptions");
  const [on, setOn] = useState(true);
  const [checked, setChecked] = useState(false);
  const [sort, setSort] = useState<"newest" | "score">("newest");
  const [fonts, setFonts] = useState<string[]>(["montserrat"]);
  const [q, setQ] = useState("");
  return (
    <div className="grid gap-4 border-b border-border py-4 md:grid-cols-[12rem_1fr]">
      <p className="text-xs font-medium text-muted-foreground">Controls</p>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          <SegmentedControl
            aria-label="Scope"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "subscriptions", label: "Subscriptions" },
              { value: "receipts", label: "Receipts & account" },
              { value: "all", label: "All" },
            ]}
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={on} onCheckedChange={setOn} /> Switch
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={checked} onCheckedChange={setChecked} /> Checkbox
          </label>
          <Select
            aria-label="Sort"
            value={sort}
            onValueChange={setSort}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "score", label: "Design score" },
            ]}
          />
        </div>
        <div className="grid max-w-xl gap-3 sm:grid-cols-2">
          <SearchField value={q} onValueChange={setQ} placeholder="Search…" hint="/" />
          <MultiCombobox
            label="Font family"
            hideLabel
            options={FONTS}
            value={fonts}
            onValueChange={setFonts}
          />
        </div>
        <Tabs defaultValue="a" className="max-w-md">
          <TabsList>
            <Tab value="a">Mailboxes</Tab>
            <Tab value="b">Preferences</Tab>
            <Tab value="c">AI usage</Tab>
          </TabsList>
          <TabsPanel value="a" className="pt-3 text-sm text-muted-foreground">
            Tab panel A
          </TabsPanel>
          <TabsPanel value="b" className="pt-3 text-sm text-muted-foreground">
            Tab panel B
          </TabsPanel>
          <TabsPanel value="c" className="pt-3 text-sm text-muted-foreground">
            Tab panel C
          </TabsPanel>
        </Tabs>
      </div>
    </div>
  );
}
