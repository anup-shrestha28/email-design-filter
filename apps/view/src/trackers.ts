/**
 * edf-view's own small tracker denylist (FREE-TIER.md §9.3 "the tracker list; trackers get a 1×1").
 *
 * The primary decision is edf-app's: it runs @edf/core/policy (tracker hosts, pixels,
 * per-recipient URLs, image policy) and only mints Ed25519 image tokens for allowed URLs, so an
 * attacker cannot get a token for anything edf-app refused. edf-view may not depend on
 * @edf/core, so this list is a second layer for hosts that exist only to track opens.
 */
const TRACKER_SUFFIXES = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "list-manage.com", // Mailchimp open tracking (images live on mcusercontent.com)
  "mailtrack.io",
  "mailfoogae.appspot.com", // Streak
  "t.yesware.com",
  "bananatag.com",
  "getnotify.com",
  "emltrk.com",
  "mailstat.us",
  "pixel.wp.com",
  "bat.bing.com",
  "ct.sendgrid.net",
  "mandrillapp.com",
  "open.convertkit-mail.com",
  "open.convertkit-mail2.com",
  "track.hubspot.com",
  "pi.pardot.com",
  "p.typekit.net",
  "track.mixmax.com",
  "r.superhuman.com",
  "mixpanel.com",
  "facebook.com",
];

/** True if the image URL's host is a tracker-exclusive host (or a subdomain of one). */
export function isTrackerUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true; // unparsable: treat as not fetchable
  }
  return TRACKER_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}
