/**
 * View models: the only shapes the UI renders. Server-only query functions produce them;
 * Client Components receive them as serialisable props (dates as ISO strings).
 */
import type {
  AuthVerdict,
  EmailType,
  Importance,
  TrustBadge,
  TypeGroup,
  TypeSource,
} from "@edf/core/types";
import type {
  DesignBand,
  DesignIssue,
  FontProfile,
  ScoreResult,
  ScoreSummary,
} from "@edf/design/types";
import type {
  EmailGalleryCategory,
  GalleryCategory,
  GalleryProblem,
  GalleryReason,
  Verdict,
} from "@/lib/gallery";
import type { Waiting } from "@/lib/gallery-waiting";
import type { PreviewFrame } from "@/lib/gallery-preview";

export type ISODate = string;

export type DesignFilter =
  "good" | "needs_work" | "bad" | "provisional" | "plain_text" | "not_analysed";
export type DealFilter = "active" | "ending" | "has_code";
export type FrequencyBand = "daily" | "several_weekly" | "weekly" | "monthly" | "rare";
export type Scope = "subscriptions" | "receipts" | "all";
export type SortKey = "newest" | "oldest" | "score" | "importance" | "deal_ending";

/** Why an on-demand render can't run while the owner has the `kill.render` emergency stop on. */
export const RENDERS_SWITCHED_OFF =
  "Design renders are switched off for now. They come back when the app's owner turns them on again.";

/** Why an on-demand render can't run while no renderer is set up (RENDERER=off, or no Sandbox snapshot). */
export const RENDERER_NOT_SET_UP =
  "Design renders aren't set up on this app yet, so emails can't be analysed. They start once the app's owner finishes setting up the renderer.";

export const SMART_VIEWS = [
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
] as const;
export type SmartView = (typeof SMART_VIEWS)[number];

/** Inbox filter state (URL-encoded with nuqs, except free-text search which never goes into the URL). */
export interface InboxFilters {
  scope: Scope;
  view: SmartView | null;
  types: TypeGroup[];
  subtypes: string[];
  importance: Importance[];
  design: DesignFilter[];
  issues: DesignIssue[];
  /** Case-folded font keys (see FontOption.key). */
  fonts: string[];
  webFonts: boolean;
  senderId: string | null;
  newSenders: boolean;
  frequency: FrequencyBand[];
  stillSending: boolean;
  unread: boolean;
  notOpened: boolean;
  done: "done" | "not_done" | null;
  pinned: boolean;
  deals: DealFilter[];
  suspicious: boolean;
  date: "24h" | "7d" | "30d" | "90d" | null;
  mailboxId: string | null;
  language: string | null;
  sort: SortKey;
}

export interface DesignSnapshot {
  status: "pending" | "done" | "failed" | "skipped" | "plain_text";
  source: "none" | "static" | "template" | "render";
  aiState:
    "pending" | "queued" | "done" | "from_template" | "flagged" | "failed" | "not_applicable";
  score: number | null;
  band: DesignBand | null;
  provisional: boolean;
  capped: boolean;
  issues: DesignIssue[];
  confidence: "high" | "medium" | "low" | null;
}

export interface InboxItem {
  id: string;
  receivedAt: ISODate;
  subject: string | null;
  /** Null for security-sensitive mail (DESIGN.md §7.4). */
  snippet: string | null;
  fromName: string | null;
  fromAddress: string | null;
  senderId: string | null;
  senderDomain: string | null;
  primaryType: EmailType;
  typeGroup: TypeGroup;
  subtype: string | null;
  typeSource: TypeSource;
  /** Effective importance at read time (lapsed boosts removed). */
  importance: Importance;
  importanceReasons: string[];
  design: DesignSnapshot;
  deal: { endsAt: ISODate | null; hasCode: boolean } | null;
  isUnread: boolean;
  openedInApp: boolean;
  done: boolean;
  pinned: boolean;
  starred: boolean;
  suspicious: boolean;
  securitySensitive: boolean;
  isSubscription: boolean;
  fontFamilies: string[];
  trackerCount: number;
}

export interface InboxPage {
  items: InboxItem[];
  /** Opaque keyset cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /** Pinned, not-done emails matching the filters (first page only; "Pin keeps it on top"). */
  pinned: InboxItem[];
}

export interface FacetCounts {
  total: number;
  types: Partial<Record<TypeGroup, number>>;
  importance: Partial<Record<Importance, number>>;
  design: Partial<Record<DesignFilter, number>>;
  issues: Partial<Record<DesignIssue, number>>;
  deals: Partial<Record<DealFilter, number>>;
  unread: number;
  suspicious: number;
}

export interface FontOption {
  /** lower(name) */
  key: string;
  label: string;
  count: number;
}

export interface SmartViewCount {
  view: SmartView;
  count: number;
}

export interface DealView {
  id: string;
  kind: "percent_off" | "amount_off" | "bogo" | "free_shipping" | "gift" | "other";
  value: number | null;
  currency: string | null;
  isUpTo: boolean;
  minSpend: number | null;
  code: string | null;
  endsAt: ISODate | null;
  endsAtConfidence: number | null;
}

export interface EmailDetail {
  id: string;
  subject: string | null;
  snippet: string | null;
  fromName: string | null;
  fromAddress: string | null;
  senderId: string | null;
  senderDomain: string | null;
  receivedAt: ISODate;
  mailboxAddress: string;
  labels: string[];
  gmailCategory: string | null;
  language: string | null;
  classification: {
    primaryType: EmailType;
    typeGroup: TypeGroup;
    subtype: string | null;
    secondaryTags: string[];
    typeSource: TypeSource;
    typeConfidence: number | null;
    isSubscription: boolean;
    subscriptionScore: number | null;
    securitySensitive: boolean;
    suspicious: boolean;
  };
  importance: { level: Importance; score: number | null; reasons: string[] };
  trust: TrustBadge | null;
  auth: { result: "pass" | "fail" | "none" | "unknown"; dmarc: AuthVerdict | null };
  espPlatform: string | null;
  deals: DealView[];
  design: {
    snapshot: DesignSnapshot;
    /** The gallery verdict (lib/gallery.ts verdictOf, same inputs as the gallery); absent in old callers. */
    verdict?: Verdict;
    /** Full result when features are kept (≤ 30 d you / 14 d friends), else null. */
    result: ScoreResult | null;
    /** Always present once analysed; used after compaction ("saved summary"). */
    summary: ScoreSummary | null;
    renderRef: { emailId: string; renderedAt: ISODate } | null;
    analyzedAt: ISODate | null;
    /** Iframe heights measured by the renderer (CSS px). */
    layout: { desktopHeight: number; mobileHeight: number } | null;
  };
  fonts: FontProfile | null;
  /** Signed, short-lived viewer URLs (edf-view). Null when the viewer is unavailable. */
  viewer: { src: string; srcImagesOff: string; expiresAt: ISODate } | null;
  /**
   * The governor has images click-to-load for this user (friends at L1 / Fast Origin Transfer soft,
   * everyone at L2 / its self-cap; FREE-TIER.md §8.2–8.3): the viewer opens with images off and
   * loads them only when the reader turns them on. Absent → images load as usual.
   */
  imagesClickToLoad?: boolean;
  unsubscribe: { https: string | null; mailto: string | null; oneClick: boolean };
  state: {
    isUnread: boolean;
    openedInAppAt: ISODate | null;
    doneAt: ISODate | null;
    pinnedAt: ISODate | null;
  };
  /** What the user may do right now, with their remaining daily allowance. */
  actions: {
    canAnalyze: boolean;
    canRunAiReview: boolean;
    analyzeRemainingToday: number;
    aiReviewRemainingToday: number;
    renderQueued: boolean;
    reason: string | null;
    /**
     * Why "Run AI review" alone is unavailable for an email that can otherwise be analysed (suspicious
     * mail is never sent to AI); null/absent → only `reason`, the pause or the allowance can stop it.
     */
    aiReason?: string | null;
    /** Plain-English reason the governor has on-demand renders paused for this user; null/absent → they run. */
    rendersPaused?: string | null;
  };
  trackerCount: number;
  utmCampaign: string | null;
}

/** `requestAnalyze` result: queued for a render VM, or not queued because renders are paused (and why). */
export type AnalyzeOutcome = { status: "queued" } | { status: "paused"; reason: string };

export interface SenderRow {
  id: string;
  displayName: string | null;
  address: string;
  domain: string;
  emailCount: number;
  unreadCount: number;
  emailsPerWeek: number | null;
  frequencyBand: FrequencyBand | null;
  readRate60d: number | null;
  avgDesignScore: number | null;
  oneClickUnsubscribe: boolean | null;
  hasUnsubscribe: boolean;
  trustState: "trusted" | "partial" | "failed_auth" | null;
  primaryType: EmailType | null;
  firstSeenAt: ISODate;
  lastSeenAt: ISODate;
  isNew: boolean;
  muted: boolean;
  importanceBias: number;
  unsubscribedAt: ISODate | null;
  stillSending: boolean;
  topFonts: string[];
}

export interface SenderProfile {
  sender: SenderRow;
  designTrend: Array<{ month: string; avgScore: number | null; count: number }>;
  fonts: Array<{ family: string; emails: number }>;
  typeMix: Array<{ group: TypeGroup; count: number }>;
  templates: Array<{
    id: string;
    emailCount: number;
    firstSeenAt: ISODate;
    lastSeenAt: ISODate;
    exemplarEmailId: string | null;
    exemplarRenderedAt: ISODate | null;
    aiReviewed: boolean;
  }>;
  recentEmails: InboxItem[];
}

export interface InsightsData {
  rangeDays: number;
  totals: {
    emails: number;
    senders: number;
    subscriptions: number;
    designed: number;
    avgScore: number | null;
  };
  volumeByWeek: Array<{ week: string } & Partial<Record<TypeGroup, number>>>;
  typeMix: Array<{ group: TypeGroup; count: number }>;
  topSenders: Array<{ id: string; name: string; count: number; readRate: number | null }>;
  frequencySpikes: Array<{ id: string; name: string; last7: number; prior28Weekly: number }>;
  designDistribution: Array<{ bucket: string; count: number; band: DesignBand }>;
  bandShare: Array<{ band: DesignBand | "provisional" | "not_analysed"; count: number }>;
  bestSenders: Array<{ id: string; name: string; avgScore: number; emails: number }>;
  worstSenders: Array<{ id: string; name: string; avgScore: number; emails: number }>;
  topIssues: Array<{ issue: DesignIssue; count: number }>;
  fonts: Array<{ family: string; emails: number }>;
  webVsSystem: { webFontEmails: number; systemOnlyEmails: number };
  tracking: { emailsWithPixels: number; total: number; share: number };
  cleanupCandidates: SenderRow[];
}

export interface TodayData {
  firstName: string;
  sync: SyncStatus;
  needsAttention: InboxItem[];
  dealsEndingSoon: InboxItem[];
  newSinceLastVisit: number;
  last24h: { total: number; byGroup: Partial<Record<TypeGroup, number>> };
  designHighlights: { best: InboxItem | null; worst: InboxItem | null };
  aiPendingCount: number;
}

export interface MailboxInfo {
  id: string;
  emailAddress: string;
  status: "connecting" | "active" | "needs_reauth" | "paused" | "disconnecting";
  statusReason: string | null;
  lastSyncedAt: ISODate | null;
  nextPollAt: ISODate | null;
  backfill: {
    state: "pending" | "running" | "done" | "failed";
    windowDays: number;
    listed: number;
    stored: number;
    queuedPosition: number | null;
  };
  health: { pending: number; stored: number; skipped: number; failed: number };
  resyncPending: boolean;
}

export interface SyncStatus {
  mailboxes: MailboxInfo[];
  syncing: boolean;
  lastSyncedAt: ISODate | null;
  /**
   * Human text for the sync chip, e.g. "Synced 4 min ago". `id` names the banner's situation (e.g.
   * `import:<mailboxId>`) and stays the same while its text changes (a live import count), so a
   * dismissal sticks until the situation itself changes.
   */
  banner: { id: string; level: "info" | "warning" | "error"; text: string } | null;
  /** The governor has the UI's sync-status polling off (L1, FREE-TIER.md §8.2); absent → it polls. */
  pollingOff?: boolean;
}

export interface SettingsData {
  user: { name: string; email: string; role: "owner" | "friend"; image: string | null };
  settings: {
    timezone: string;
    loadImagesForAnalysis: boolean;
    linkCheckOptIn: boolean;
    backfillWindowDays: 30 | 90 | 180;
    aiProcessingConsentAt: ISODate | null;
  };
  mailboxes: MailboxInfo[];
  ai: { spentThisMonthUsd: number; monthCapUsd: number; dayCapUsd: number };
  invites: Array<{
    email: string;
    role: "owner" | "friend";
    createdAt: ISODate;
    usedAt: ISODate | null;
  }> | null;
  googleAccountsUsed: number;
}

export interface ResourceRow {
  key: string;
  label: string;
  unit: string;
  used: number;
  selfCap: number;
  hardLimit: number;
  window: "rolling_30d" | "month" | "billing_period" | "now";
  /** used / selfCap */
  ratio: number;
}

export interface SystemStatus {
  governor: {
    level: 0 | 1 | 2 | 3;
    triggers: string[];
    since: ISODate | null;
    recommendTick60: boolean;
  };
  resources: ResourceRow[];
  heartbeats: {
    lastTickAt: ISODate | null;
    lastMaintenanceAt: ISODate | null;
    lastRenderBatchAt: ISODate | null;
    lastCronAt: ISODate | null;
    inngestPaused: boolean;
    tickEvery: 30 | 60;
  };
  mailboxes: {
    total: number;
    active: number;
    needsReauth: number;
    backfilling: number;
    failingLedgerRows: number;
    pendingLedgerRows: number;
  };
  ai: { reservedUsd: number; capUsd: number; paused: boolean; pausedReason: string | null };
  errors: Array<{ code: string; job: string; count: number; lastAt: ISODate }>;
  googleAccounts: { used: number; alertAt: number; stopAt: number; limit: number };
  killSwitches: Record<string, boolean>;
  users: number;
  /** Server-known problems the owner should fix, in plain English (codes are stable for the UI). */
  warnings: Array<{ code: "KEYS_ALERT_UNCONFIGURED" | "GOOGLE_ACCOUNTS_HIGH"; message: string }>;
}

// ───────────────────────── design gallery ─────────────────────────

/** One card in the design gallery (queries/gallery.ts). */
export interface GalleryItem {
  id: string;
  sender: { name: string; domain: string | null };
  subject: string | null;
  receivedAt: ISODate;
  category: EmailGalleryCategory;
  score: number | null;
  band: DesignBand | null;
  verdict: Verdict;
  /** One short plain-English line for the card (≤ 120 chars); null when not scored. */
  reason: GalleryReason | null;
  /** Up to 3 each, for the detail view. */
  problems: string[];
  strengths: string[];
  /** Up to 3 font family names. */
  fonts: string[];
  /** False only when the viewer can't show this email (e.g. its mailbox is disconnected). */
  previewable: boolean;
  /** Where the design sits in the 800 px desktop render (card crop + hover drift); null when not rendered. */
  frame?: PreviewFrame | null;
  /** Unscored only: when the score will come, from the real render queue (lib/gallery-waiting.ts). */
  waiting?: Waiting | null;
  /** Saved in at least one of the user's boards (the card's Save button). */
  saved?: boolean;
}

/** One numbered page of the gallery. */
export interface GalleryPage {
  items: GalleryItem[];
  /** Designs matching the filters, on every page. */
  total: number;
  /** The page shown (the one asked for, clamped to 1..pageCount). */
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Counts for the gallery's filters; each group respects the OTHER active filters (and the search). */
export interface GalleryFacets {
  categories: Record<GalleryCategory, number>;
  design: { all: number; good: number; bad: number };
  fonts: Array<{ name: string; count: number }>;
  /**
   * Top senders (most designs first), plus any selected sender even when it has none here.
   * `address` tells apart senders that share a name ("LinkedIn" sends from four addresses).
   */
  senders: Array<{
    id: string;
    name: string;
    domain: string | null;
    address: string;
    count: number;
  }>;
  /** Designs with each Problems option (lib/gallery.ts GALLERY_PROBLEMS). */
  problems: Record<GalleryProblem, number>;
  /** Every connected mailbox (the Mailbox filter only shows with 2 or more). */
  mailboxes: Array<{ id: string; address: string; count: number }>;
  webFonts: { yes: number; no: number };
  /** The user's boards (newest first) and how many of their saved designs match the other filters. */
  boards: Array<{ id: string; name: string; count: number }>;
}
