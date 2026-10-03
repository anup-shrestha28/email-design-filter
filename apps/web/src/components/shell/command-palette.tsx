"use client";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import {
  CircleHelp,
  CornerDownLeft,
  Gauge,
  Keyboard,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Search,
  Sun,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { paletteSearch, type PaletteResults } from "@/app/(app)/actions";
import { SenderAvatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/kbd";
import { Time } from "@/components/ui/time";
import { useTheme } from "@/hooks/use-theme";
import { senderLabel } from "@/lib/avatar";
import { cn } from "@/lib/cn";
import { SMART_VIEW_LABELS } from "@/lib/filters";
import { formatNumber } from "@/lib/format";
import { inboxHref } from "@/lib/inbox-params";
import { NAV_ITEMS, SMART_VIEW_ICONS, SMART_VIEW_ORDER } from "./nav";
import { useShell } from "./shell-context";
import { useSignOut, type ShellUser } from "./user-menu";

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: ReactNode;
  icon?: LucideIcon;
  leading?: ReactNode;
  keywords?: string;
  run: () => void;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** ⌘K: jump to pages, smart views and senders, search emails, run actions. */
export function CommandPalette({ user }: { user: ShellUser }) {
  const router = useRouter();
  const { paletteOpen, setPaletteOpen, setShortcutsOpen } = useShell();
  const { setTheme } = useTheme();
  const { signOutNow } = useSignOut();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<PaletteResults | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const debounced = useDebounced(query.trim(), 180);

  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  const go = useCallback(
    (href: Route) => {
      close();
      router.push(href);
    },
    [close, router],
  );

  useEffect(() => {
    if (debounced.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    paletteSearch(debounced).then((r) => {
      if (id !== requestId.current) return;
      setLoading(false);
      setResults(r.ok ? r.data : { emails: [], senders: [], fonts: [] });
    });
  }, [debounced]);

  const staticItems = useMemo<PaletteItem[]>(() => {
    const pages: PaletteItem[] = NAV_ITEMS.filter((i) => !i.ownerOnly || user.role === "owner").map(
      (i) => ({
        id: `page:${i.href}`,
        group: "Go to",
        label: i.label,
        icon: i.icon,
        hint: i.shortcut ? (
          <span className="flex gap-0.5">
            {i.shortcut.split(" ").map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        ) : undefined,
        run: () => go(i.href),
      }),
    );
    const views: PaletteItem[] = SMART_VIEW_ORDER.map((v) => ({
      id: `view:${v}`,
      group: "Smart views",
      label: SMART_VIEW_LABELS[v],
      icon: SMART_VIEW_ICONS[v],
      run: () => go(inboxHref({ view: v, scope: "all" }) as Route),
    }));
    const actions: PaletteItem[] = [
      {
        id: "act:light",
        group: "Actions",
        label: "Switch to light theme",
        icon: Sun,
        keywords: "theme appearance",
        run: () => {
          setTheme("light");
          close();
        },
      },
      {
        id: "act:dark",
        group: "Actions",
        label: "Switch to dark theme",
        icon: Moon,
        keywords: "theme appearance",
        run: () => {
          setTheme("dark");
          close();
        },
      },
      {
        id: "act:system",
        group: "Actions",
        label: "Use system theme",
        icon: Monitor,
        keywords: "theme appearance",
        run: () => {
          setTheme("system");
          close();
        },
      },
      {
        id: "act:keys",
        group: "Actions",
        label: "Keyboard shortcuts",
        icon: Keyboard,
        run: () => {
          close();
          setShortcutsOpen(true);
        },
      },
      {
        id: "act:help",
        group: "Actions",
        label: "Help",
        icon: CircleHelp,
        run: () => {
          close();
          window.location.assign("/help");
        },
      },
      {
        id: "act:score",
        group: "Actions",
        label: "How we judge designs",
        icon: Gauge,
        run: () => {
          close();
          window.location.assign("/how-we-score");
        },
      },
      {
        id: "act:out",
        group: "Actions",
        label: "Sign out",
        icon: LogOut,
        run: () => {
          close();
          void signOutNow();
        },
      },
    ];
    return [...pages, ...views, ...actions];
  }, [close, go, setShortcutsOpen, setTheme, signOutNow, user.role]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? staticItems.filter((i) => `${i.label} ${i.keywords ?? ""}`.toLowerCase().includes(q))
      : staticItems.filter((i) => i.group !== "Actions" || i.id === "act:keys");
    if (!results || q.length < 2) return matched;
    const emails: PaletteItem[] = results.emails.map((e) => ({
      id: `email:${e.id}`,
      group: "Emails",
      label: e.subject ?? "(no subject)",
      leading: <SenderAvatar name={e.fromName} domain={e.senderDomain} size="sm" />,
      hint: (
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-subtle-foreground">
          <span className="max-w-40 truncate">{senderLabel(e.fromName, e.fromAddress)}</span>
          <span aria-hidden>·</span>
          <Time iso={e.receivedAt} variant="list" withTitle={false} />
        </span>
      ),
      run: () => go(`/email/${e.id}` as Route),
    }));
    const senders: PaletteItem[] = results.senders.map((s) => ({
      id: `sender:${s.id}`,
      group: "Senders",
      label: s.displayName ?? s.address,
      leading: <SenderAvatar name={s.displayName} domain={s.domain} size="sm" />,
      hint: (
        <span className="text-xs text-subtle-foreground">
          {s.domain} · {formatNumber(s.emailCount)} emails
        </span>
      ),
      run: () => go(`/senders/${s.id}` as Route),
    }));
    const fonts: PaletteItem[] = results.fonts.map((f) => ({
      id: `font:${f.key}`,
      group: "Filters",
      label: `Filter by font: ${f.label} (${formatNumber(f.count)})`,
      icon: Type,
      run: () => go(inboxHref({ fonts: [f.key], scope: "all" }) as Route),
    }));
    return [...emails, ...senders, ...fonts, ...matched];
  }, [go, query, results, staticItems]);

  useEffect(() => setActive(0), [query, results]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[active]?.run();
    }
  }

  const grouped = useMemo(() => {
    const out: Array<{ group: string; entries: Array<{ item: PaletteItem; index: number }> }> = [];
    items.forEach((item, index) => {
      const last = out.at(-1);
      if (last && last.group === item.group) last.entries.push({ item, index });
      else out.push({ group: item.group, entries: [{ item, index }] });
    });
    return out;
  }, [items]);

  const activeId = items[active] ? `${listboxId}-${active}` : undefined;
  const searching = query.trim().length >= 2;

  return (
    <BaseDialog.Root
      open={paletteOpen}
      onOpenChange={(o) => {
        setPaletteOpen(o);
        if (!o) setQuery("");
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-[80] bg-[oklch(0.18_0.01_270/0.4)] backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 dark:bg-black/60" />
        <BaseDialog.Viewport className="fixed inset-0 z-[81] flex items-start justify-center px-3 pt-[10vh] sm:pt-[14vh]">
          <BaseDialog.Popup
            aria-label="Command palette"
            className="flex max-h-[min(34rem,76vh)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-overlay outline-none transition-[transform,opacity] duration-150 ease-out-quint data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
          >
            <BaseDialog.Title className="sr-only">Search and commands</BaseDialog.Title>
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              {loading ? (
                <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" aria-hidden />
              ) : (
                <Search className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
              )}
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={100}
                placeholder="Search emails and senders, or jump to…"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                autoComplete="off"
                spellCheck={false}
                className="h-12 min-w-0 flex-1 bg-transparent text-[0.9375rem] text-foreground outline-none placeholder:text-subtle-foreground"
              />
              <Kbd className="hidden sm:inline-flex">esc</Kbd>
            </div>
            <div
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label="Results"
              className="min-h-0 flex-1 overflow-y-auto p-1.5"
            >
              {grouped.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {loading
                    ? "Searching…"
                    : searching
                      ? "No emails, senders or pages match."
                      : "Type to search."}
                </p>
              ) : (
                grouped.map((g) => (
                  <div key={g.group} role="group" aria-label={g.group} className="mb-1 last:mb-0">
                    <div className="px-2.5 pt-2 pb-1 text-2xs font-medium tracking-[0.06em] text-subtle-foreground uppercase">
                      {g.group}
                    </div>
                    {g.entries.map(({ item, index }) => {
                      const Icon = item.icon;
                      return (
                        <div
                          key={item.id}
                          id={`${listboxId}-${index}`}
                          role="option"
                          aria-selected={index === active}
                          data-index={index}
                          onMouseMove={() => setActive(index)}
                          onClick={() => item.run()}
                          className={cn(
                            "flex h-10 cursor-default items-center gap-3 rounded-md px-2.5 text-sm text-foreground select-none",
                            index === active && "bg-surface-muted",
                          )}
                        >
                          {item.leading ??
                            (Icon ? (
                              <Icon
                                className="size-4 shrink-0 text-subtle-foreground"
                                aria-hidden
                              />
                            ) : null)}
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.hint ? (
                            <span className="flex shrink-0 items-center">{item.hint}</span>
                          ) : null}
                          {index === active ? (
                            <CornerDownLeft
                              className="size-3.5 shrink-0 text-subtle-foreground"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <div className="hidden items-center gap-4 border-t border-border px-4 py-2 text-2xs text-subtle-foreground sm:flex">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> to open
              </span>
              <span className="ml-auto">
                Search text is never put into a link or your browser history.
              </span>
            </div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
