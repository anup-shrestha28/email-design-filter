/**
 * Where the full email page's back link goes. The gallery's "Open full analysis" passes its own
 * URL (filters included) as `?back=`; only a same-origin path under an app list page is accepted —
 * never `//host`, a scheme, a backslash or a dot segment — so it can't become an open redirect.
 * Anything else falls back to the gallery. Client-safe, pure.
 */

const BACK_PATH =
  /^\/(gallery|inbox|senders|today|insights)(?:\/[A-Za-z0-9_-]+)?(?:\?[A-Za-z0-9._~%!$&'()*+,;=:@/?-]*)?$/;
const UNSAFE = /\/\/|\\|%2f|%5c|(?:^|\/)(?:\.|%2e){1,2}(?=\/|\?|$)/i;

const LABELS: Record<string, string> = {
  gallery: "All designs",
  inbox: "Inbox",
  senders: "Senders",
  today: "Today",
  insights: "Insights",
};

export const DEFAULT_BACK = { href: "/gallery", label: "All designs" } as const;

export function backLinkOf(back: string | string[] | undefined | null): {
  href: string;
  label: string;
} {
  const v = Array.isArray(back) ? back[0] : back;
  if (typeof v !== "string" || v.length > 1024) return DEFAULT_BACK;
  const m = BACK_PATH.exec(v);
  if (!m || UNSAFE.test(v)) return DEFAULT_BACK;
  return { href: v, label: LABELS[m[1]!] ?? DEFAULT_BACK.label };
}
