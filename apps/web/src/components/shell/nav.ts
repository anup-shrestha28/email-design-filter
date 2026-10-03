import {
  Archive,
  ChartColumn,
  CircleAlert,
  Inbox,
  LayoutGrid,
  MailWarning,
  Newspaper,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sunrise,
  Timer,
  TriangleAlert,
  UserRoundPlus,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { SmartView } from "@/server/queries/types";

export interface NavItem {
  href: "/gallery" | "/today" | "/inbox" | "/senders" | "/insights" | "/settings" | "/system";
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  ownerOnly?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/gallery", label: "Designs", icon: LayoutGrid, shortcut: "g d" },
  { href: "/today", label: "Today", icon: Sunrise, shortcut: "g t" },
  { href: "/inbox", label: "Inbox list", icon: Inbox, shortcut: "g i" },
  { href: "/senders", label: "Senders", icon: Users, shortcut: "g s" },
  { href: "/insights", label: "Insights", icon: ChartColumn, shortcut: "g n" },
  { href: "/settings", label: "Settings", icon: Settings, shortcut: "g ," },
  { href: "/system", label: "System", icon: Server, ownerOnly: true },
];

export const SMART_VIEW_ICONS: Record<SmartView, LucideIcon> = {
  needs_attention: CircleAlert,
  deals_ending: Timer,
  security: ShieldCheck,
  suspicious: ShieldAlert,
  newsletters_i_read: Newspaper,
  best_designed: Sparkles,
  bad_design: TriangleAlert,
  new_senders: UserRoundPlus,
  cleanup_never_opened: Archive,
  still_sending: MailWarning,
};

/** Order in the sidebar: triage first, then design, then cleanup. */
export const SMART_VIEW_ORDER: SmartView[] = [
  "needs_attention",
  "deals_ending",
  "security",
  "suspicious",
  "newsletters_i_read",
  "best_designed",
  "bad_design",
  "new_senders",
  "cleanup_never_opened",
  "still_sending",
];

export function isActivePath(pathname: string, href: string): boolean {
  if (href === "/inbox") return pathname === "/inbox" || pathname.startsWith("/email/");
  return pathname === href || pathname.startsWith(`${href}/`);
}
