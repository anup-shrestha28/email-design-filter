/**
 * Tracker host lists — our own, written from vendor documentation and public header/link
 * samples in the spirit of Trocker (Apache-2.0). Deliberately NOT derived from Disconnect or
 * DuckDuckGo lists (CC BY-NC-SA, non-commercial; DESIGN.md §7.6).
 *
 * Two lists with different meanings:
 * - TRACKER-EXCLUSIVE: hosts that serve open pixels / redirects but never content images, so any
 *   image from them is a tracker (DESIGN-SCORE §2.1). Vendors that host content images on the
 *   same domain (e.g. SendGrid's image CDN on sendgrid.net) are NOT listed here; their pixels are
 *   caught by path pattern + size instead.
 * - CLICK: redirect hosts that log clicks (ESP click domains and public link shorteners).
 *
 * Entries are registrable domains (matched against the host's eTLD+1), exact hosts, or regexes
 * over the registrable domain for vendors with numbered domains.
 */

export const TRACKER_EXCLUSIVE_DOMAINS: ReadonlySet<string> = new Set([
  "list-manage.com", // Mailchimp tracking + unsubscribe; content images live on mcusercontent.com
  "mandrillapp.com", // Mandrill /track/open.php, /track/click
  "klaviyomail.com", // Klaviyo trk./ctrk. tracking
  "hubspotlinks.com",
  "hubspotemail.net",
  "exct.net", // Salesforce Marketing Cloud click/open
  "rs6.net", // Constant Contact redirects
  "awstrack.me", // Amazon SES open/click tracking
  "pstmrk.it", // Postmark click tracking
  "sparkpostmail.com",
  "spgo.io",
  "soundestlink.com", // Omnisend
  "en25.com", // Oracle Eloqua
  "emltrk.com", // Litmus email analytics
  "mailtrack.io",
  "mltrk.io",
  "bananatag.com",
  "getnotify.com",
  "google-analytics.com",
  "doubleclick.net",
]);

export const TRACKER_EXCLUSIVE_HOSTS: ReadonlySet<string> = new Set([
  "pixel.inbox.exacttarget.com",
  "click.exacttarget.com",
  "ctrk.klaviyo.com",
  "eotrx.substackcdn.com", // Substack open pixel (content images use other substackcdn hosts)
  "openrate.aweber.com",
  "clicks.aweber.com",
  "t.yesware.com",
  "mailfoogae.appspot.com", // Streak
  "r.superhuman.com",
  "bat.bing.com",
  "ct.pinterest.com",
  "px.ads.linkedin.com",
  "analytics.twitter.com",
  "pixel.wp.com",
]);

export const TRACKER_EXCLUSIVE_PATTERNS: readonly RegExp[] = [
  /^klclick\d*\.com$/, // Klaviyo click domains
  /^convertkit-mail\d*\.com$/, // Kit (ConvertKit) click./open. tracking
  /^sidekickopen\d+\.com$/, // HubSpot Sales tracking
  /^acemln[a-d]\.com$/, // ActiveCampaign tracking
  /^rsys\d+\.net$/, // Oracle Responsys
];

/** Click-redirect hosts (superset of the exclusive list's redirectors plus shorteners). */
export const CLICK_TRACKER_DOMAINS: ReadonlySet<string> = new Set([
  "list-manage.com",
  "mandrillapp.com",
  "klaviyomail.com",
  "sendgrid.net",
  "hubspotlinks.com",
  "hubspotemail.net",
  "exct.net",
  "rs6.net",
  "awstrack.me",
  "pstmrk.it",
  "sparkpostmail.com",
  "spgo.io",
  "soundestlink.com",
  "en25.com",
  "mjt.lu",
  "mailchi.mp",
  "attn.tv",
  // public shorteners (redirects that log clicks)
  "bit.ly",
  "t.co",
  "lnkd.in",
  "ow.ly",
  "buff.ly",
  "tinyurl.com",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
]);

export const CLICK_TRACKER_HOSTS: ReadonlySet<string> = new Set([
  "click.exacttarget.com",
  "ctrk.klaviyo.com",
  "clicks.aweber.com",
  "click.mailerlite.com",
  "link.mail.beehiiv.com",
  "links.iterable.com",
  "via.intercom.io",
  "t.yesware.com",
]);

export const CLICK_TRACKER_PATTERNS: readonly RegExp[] = [
  /^klclick\d*\.com$/,
  /^convertkit-mail\d*\.com$/,
  /^sidekickopen\d+\.com$/,
  /^acemln[a-d]\.com$/,
  /^rsys\d+\.net$/,
];

/**
 * Click-tracking URL shapes used on branded (custom) tracking domains. Matched against the
 * lower-cased path (+ query keys where noted).
 */
export const CLICK_PATH_PATTERNS: readonly RegExp[] = [
  /^\/ls\/click/, // SendGrid / Klaviyo "ls/click?upn="
  /^\/wf\/click/, // SendGrid
  /^\/track\/click/, // Mailchimp / Mandrill
  /^\/e\/c\//, // Customer.io
  /^\/c\/[a-z0-9_=-]{16,}/, // Mailgun "/c/<token>"
  /^\/cl0\//, // Amazon SES "/CL0/<url>"
  /^\/lnk\//, // Mailjet
  /^\/tr\/cl\//, // Brevo
  /^\/redirect\/[a-z0-9-]{8,}/, // Substack "/redirect/<id>"
  /^\/pub\/cc/, // Oracle Responsys
];

/** Query keys that only appear on click-tracking redirects (lower-case). */
export const CLICK_QUERY_KEYS: readonly string[] = ["upn", "_ri_", "elqtrackid"];

/** Last path segments that are open-pixel endpoints. */
export const PIXEL_LAST_SEGMENTS: ReadonlySet<string> = new Set([
  "open",
  "open.gif",
  "open.png",
  "open.aspx",
  "open.php",
  "o.gif",
  "pixel",
  "pixel.gif",
  "pixel.png",
  "1x1.gif",
  "1x1.png",
  "beacon",
  "beacon.gif",
  "track.gif",
  "t.gif",
  "blank.gif",
  "spacer.gif",
  "trans.gif",
  "transparent.gif",
  "clear.gif",
  "imp",
  "impression",
  "impression.gif",
]);

/** Path prefixes of open-pixel endpoints (lower-case). */
export const PIXEL_PATH_PREFIXES: readonly string[] = [
  "/track/open",
  "/wf/open",
  "/e/o/",
  "/e/eo",
  "/tr/op/",
  "/oo/",
  "/open/",
  "/pixel/",
  "/beacon/",
  "/i0/",
  "/imp/",
  "/trk/open",
  "/t/open",
];

/** Mailgun-style "/o/<token>" open pixel. */
export const PIXEL_PATH_REGEXES: readonly RegExp[] = [/^\/o\/[a-z0-9_=-]{16,}/];

/**
 * Static-asset CDNs whose long path tokens are asset identifiers shared by all recipients.
 * Recipient address/hash checks and query-token checks still apply to them.
 */
export const STATIC_ASSET_CDN_DOMAINS: ReadonlySet<string> = new Set([
  "googleusercontent.com",
  "ggpht.com",
  "gstatic.com",
  "ctfassets.net",
  "cloudinary.com",
  "imgix.net",
  "shopify.com",
  "squarespace-cdn.com",
  "mcusercontent.com",
  "braze-images.com",
  "filekitcdn.com",
  "wixstatic.com",
  "ytimg.com",
  "twimg.com",
  "fbcdn.net",
  "licdn.com",
  "sanity.io",
  "hubspotusercontent00.net",
  "hubspotusercontent10.net",
  "hubspotusercontent20.net",
  "hubspotusercontent30.net",
  "hubspotusercontent40.net",
]);

/**
 * Upload stores of an ESP's image library, matched by EXACT host and path shape (narrower than
 * STATIC_ASSET_CDN_DOMAINS, whose registrable domain may also serve tracking): their path tokens
 * are asset ids shared by every recipient, so the path is not token-checked. The query and the
 * recipient address/hash checks still run, and so do the pixel rules.
 *
 * Customer.io serves images uploaded to a workspace's asset library from `userimg-assets` (US)
 * and `userimg-assets-eu` (EU) as `/images/client-env-<workspace>/<upload ms>_<file name>_<ULID>.png`
 * or `/<ULID>.png`; a ULID is 26 Crockford base32 characters, so every such image read as a
 * per-recipient token (checked on 2026-09-30: Supabase and Lovable emails lost every content
 * image, logos included). Its open pixels live elsewhere (`<branded host>/e/o/<token>`, the pixel
 * path rule) and `customeriomail.com` itself also carries tracking hosts, so only these two hosts
 * and this path shape are exempt.
 */
export const STATIC_ASSET_UPLOAD_PATHS: ReadonlyMap<string, RegExp> = new Map([
  ["userimg-assets.customeriomail.com", /^\/images\/client-env-\d{1,12}\/[^/]+$/],
  ["userimg-assets-eu.customeriomail.com", /^\/images\/client-env-\d{1,12}\/[^/]+$/],
]);

/**
 * Per-CDN signed-URL parameters whose value is exactly one signature, matched by name AND shape.
 * LinkedIn's media CDN (profile photos, post images) refuses a URL without `t` ("Missing t query
 * string"); `t` is 43 base64url characters = one 32-byte HMAC over path + `e` + `v`, so it has no
 * room for a recipient id besides the signature, and the same photo carries the same `t` in every
 * email (checked on 14 real LinkedIn emails: one `t` per path across emails and days). Any other
 * shape still goes through the per-recipient token check.
 */
export const STATIC_SIGNED_URL_PARAMS: ReadonlyMap<string, { key: string; shape: RegExp }> =
  new Map([["licdn.com", { key: "t", shape: /^[A-Za-z0-9_-]{43}$/ }]]);

/**
 * Per-CDN expiry parameter of signed URLs, in unix seconds. Once it has passed the CDN refuses the
 * URL: LinkedIn's media CDN answers every media.licdn.com URL whose `e` is in the past with an
 * error (profile photos carry a far-future `e`; post and article images one a few weeks out). Not
 * a privacy rule: such an image can only fail, so the viewer doesn't proxy it (isExpiredSignedUrl).
 */
export const STATIC_SIGNED_URL_EXPIRY: ReadonlyMap<string, string> = new Map([["licdn.com", "e"]]);

/**
 * Upload stores on a sender's own (branded) host, matched by path shape alone: Marketo serves the
 * images uploaded to a Design Studio from `/rs/<Munchkin id>/images/<file>` on the customer's
 * landing-page domain (e.g. JetBrains' logo `…/rs/426-QVD-114/images/logo_…_72x72@2x.png`, whose
 * long consonant-heavy name read as a token). A Munchkin id is `NNN-AAA-NNN`. Only that one path
 * shape, only one file below `images/`; the query and the address/hash checks still run.
 */
export const STATIC_ASSET_UPLOAD_PATH_SHAPES: readonly RegExp[] = [
  /^\/rs\/\d{3}-[A-Z]{3}-\d{3}\/images\/[^/]+$/,
];

/** Query parameter names that carry static CDN signatures / cache busters. */
export const STATIC_SIGNATURE_PARAMS: ReadonlySet<string> = new Set([
  "s",
  "sig",
  "signature",
  "v",
  "version",
  "hash",
  "h",
  "ixlib",
  "auto",
  "fit",
  "w",
  "width",
  "height",
  "q",
  "fm",
  "crop",
]);
