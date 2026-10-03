# @edf/core — implementation decisions

Where the spec (DESIGN.md v1.1, DESIGN-SCORE.md, FREE-TIER.md, DATA-MODEL.md) was ambiguous or
silent, we chose the reading that **avoids missing important mail** and keeps user content
minimised. Each entry names the spec section and the reason.

## Parsing (postal-mime 3.0.1)

- **Limits** (`MIME_LIMITS`): raw ≤ 40 MiB (Gmail's 25 MB cap plus base64 overhead; larger raw
  messages go through the Gmail payload adapter), MIME nesting ≤ 32, header bytes across all parts
  ≤ 512 KiB, inline `message/rfc822` recursion ≤ 3. postal-mime bounds depth, not breadth, so the
  raw size is checked before parsing.
- `MimeParseError` is thrown only for empty input, over-size input (`ledgerReason: "too_large"`),
  a parser rejection, or no known header and no body (`"parse_error"`). Messages never contain
  email content.
- Header values are unfolded; RFC 2047 words are decoded except in structured headers
  (Authentication-Results, DKIM/ARC, Received, List-Unsubscribe, Content-Type, Message-ID …).
  Header names that aren't valid RFC 5322 field names are dropped.
- Inline images: ≤ 10 `image/*` parts with a Content-ID, ≤ 1 MB each; **SVG is excluded**
  (active content; the renderer rejects it anyway). AMP (`text/x-amp-html`) sets `hasAmp` and is
  not listed as an attachment.
- `calendarStart` / `calendarMethod` (added, optional) come from the first VEVENT. TZIDs are
  resolved with `Intl`, and common Outlook/Windows zone names are mapped to IANA names. Unknown
  zones fall back to UTC.

- **Addresses** (From, To, Cc, Reply-To) are parsed by our own parser from the raw, undecoded
  header values postal-mime keeps, not by postal-mime's addressParser. That one decodes a mailbox
  written only as encoded-words and re-parses it, so `=?utf-8?Q?=3Csecurity=40paypal.com=3E?=`
  came back as security@paypal.com. Encoded-words are decoded in display names only, so an
  encoded `,` `<` `@` can never add a mailbox or change an address. Entries without a usable `@`
  are dropped. `from` is the first mailbox of the first From header; without angle brackets, the
  first bare addr-spec wins (quoted strings and encoded-words are display text).
  - A quoted local part whose content is a plain dot-atom loses its quotes (`"x"@a.example` →
    `x@a.example`, the same mailbox under RFC 5322), with quoted-pairs unescaped exactly once.
    Local parts that really need quoting (spaces, `@`, `"`, `\`, invisible characters) keep them.
  - **Known difference:** the Gmail payload adapter (packages/gmail G13), used for messages too
    large for `format=raw`, still keeps those quotes, so the two paths can disagree on such rare
    senders (and `fromSelf` may not match). Aligning it is an optional follow-up.

## Headers (§7.2, §7.8, DESIGN-SCORE §9)

- **Authentication-Results**: only the topmost header whose authserv-id is exactly
  `mx.google.com`. Lower or foreign headers are ignored, so forged "pass" headers inserted by a
  sender are never trusted. Residual risk: if Gmail's own header were absent, a sender-inserted
  `mx.google.com` header could be read. Gmail stamps every externally received message, so we
  accept this.
- Multiple `dkim=` results: any `pass` makes DKIM `pass` (DMARC evaluates passing signatures).
  `dkimPassDomains` are registrable domains.
- **`auth_result = "pass"` means DMARC pass, strictly.** The importance guardrail ("LLM-sourced
  security/payment_failed raise importance only if DMARC passed") keys on it. `"fail"` = DMARC
  fail, or DKIM fail with no passing signature, or SPF fail with no DKIM pass. `"none"` covers the
  rest; `"unknown"` means no trusted header.
- **One-click** additionally requires the covering DKIM signature's `d=` to be among Gmail's
  `dkim=pass` domains. RFC 8058 requires a *valid* signature, and we can only know validity from
  the trusted header.
- A List-Unsubscribe header that is present but has no usable URI yields `{https: [], mailto: []}`
  (not null). Its presence still counts as the +35 list signal. `http:` URIs are ignored.
- ESP fingerprints keep **platform** and **MTA** apart (Braze on SES → platform Braze, MTA SES).
  `espTransactional` (added) marks sending infrastructure (SES, SendGrid, Mailgun, Postmark,
  SparkPost, Mandrill, Mailjet, Resend, Shopify) and Klaviyo `kt*`/`ks*` streams. This is the
  "transactional ESP" hard signal. Vendor header markers that the research could not verify
  carry the same weight as other evidence; the domains are the primary signal.

## Automated / subscription (§7.2)

- **Weights and thresholds are exactly §7.2's** (`SUBSCRIPTION_WEIGHTS`); `decideSubscription`
  holds the 25/45 logic.
- **`isSubscription` requires an unsubscribe mechanism** (List-Unsubscribe, List-Id or a body
  unsubscribe link), per §7.1 "list or bulk mail *with an unsubscribe mechanism*". Without this, an
  SES-sent OTP scores 45 (Feedback-ID + ESP + no-reply + category) and would become a
  "subscription".
- Ambiguous (25–44) mail gets a provisional `isSubscription` (true if List-Unsubscribe or a body
  unsubscribe link exists), because the column is NOT NULL. The sender prior or Claude resolve it
  later.
- Mail from the user's own address → ledger reason **`sent`** (the ledger has no "self" reason).
- Auto-replies are also detected from `X-Autoreply`/`X-Autorespond`, `Precedence: auto_reply`
  and localized "Automatic reply / Out of office" subjects, not only `Auto-Submitted`.
- **Extra hard "automated" signals** (so important mail is never dropped as personal): a
  security-pattern match (OTP/reset/magic link/login alert) and a no-reply local part, both
  **only from non-free-mail domains** (a friend quoting a code stays personal).
- **Self-hosted transactional mail** (WooCommerce/Shopware on their own SMTP: no ESP, list or
  Auto-Submitted headers) uses one shared predicate in both stages. The subject must be
  transactional or security wording, from a non-free-mail sender, and not a human reply thread
  (no `Re:`/`Fwd:`-style prefix, no `In-Reply-To`). Headers-only evaluation → `subject_hint`, so
  the body is fetched. Full evaluation → `transactional_pattern`, but only when the **body**
  carries transactional evidence (an order/invoice/tracking reference with a digit, an amount, a
  carrier or tracking number, or shipping/billing wording), so both stages agree for this class.
  A transactional subject over an unrelated body stays personal. `ORDER_KW` also recognises
  "order confirmed/placed/received" and WooCommerce's "Your <Shop> order has been received!".
- **Personal override** (prior contact + no list headers) applies only when **no hard signal**
  fired. §7.2 describes the check as "only for ambiguous senders". A receipt from a support
  address the user once wrote to must not be dropped.
- `needsPriorContactCheck` = not yet checked, no list headers, no hard signal, score 25–44, not
  no-reply.

## Security-sensitive (§7.3 rule 3, §7.4)

- A code keyword plus a 4–8 digit code within ~80 characters before or ~160 after it
  (split "123 456" allowed; years 1900–2099 ignored), or a reset/magic/verify keyword plus an
  action link (link text or path/query; the host is ignored).
- "No promo tokens" is checked on the primary content only, and missing a security email is
  treated as worse than minimising a promo (a miss leaks the code into renders, screenshots, Claude
  and stored snippets):
  - a promo **subject** always disqualifies;
  - a one-time **code next to a code keyword** wins over promo tokens anywhere in the body.
    Retailer sign-in mail is sent in marketing templates with a promo preheader, a "free shipping"
    banner or a "New Arrivals · Sale" nav bar above the code. The price: a promo whose discount
    code is 4–8 plain digits next to "your code" is minimised too (not rendered or scored).
    Under a **promo opening** (promo tokens in the preheader or the first 200 characters) the
    evidence must be specific, because CAN-SPAM footers pair 2FA wording with a postal code
    ("turn on two-factor authentication … CA 94103"): only keywords that name the code count
    for the keyword-near-code check. The generic "OTP", "passcode", "2-step verification",
    "two-factor" and "2FA" count only when the subject names the OTP, or when the code is bound
    to the keyword by connecting words within 40 characters and one sentence ("Your OTP for
    login is 482913", "Your 2FA code: 482 913", "482913 is your passcode", "Your OTP is valid
    for 10 minutes: 482913"). Words after "for" are admitted, but a ":" after them binds only
    when a binder word (is/code/pin/number/password) is among the connectors or the keyword opens
    its line ("Your OTP for your order: 482913"), so a footer's "Enable 2FA for extra points:
    5000" or "Enable 2FA for 5000 points" is not an OTP. Reward units (points, pts, miles,
    bonus, rewards, credits, coins, stars, entries, cashback, discount, off, voucher, coupon)
    fail safe: with no binder word among the connectors ("the number of" is not a binder), a
    number is a reward when the last connector before it, or the word right after it, is a reward
    unit ("2FA for extra points: 5000", "The 2FA for the number of points: 5000", "Enable 2FA for
    your account: 5000 bonus points"). A reward word elsewhere in the phrase never vetoes a bound
    code ("Your OTP for credit card payment is 482913", "Your OTP for Rewards login: 482913"): a
    missed code leaks it into snippets and AI input, a false positive only hides a promo. Digits inside a postal-address pattern
    (US state + ZIP, street line, PO box, AU state + postcode) are not codes. A labelled
    reference number (order/invoice/tracking/booking/confirmation/item/SKU/customer/store
    numbers, "Tel. …", "Call us: …"; label and number on one line) is not a code when a sentence
    end (". ", "! ", "? ", "; "), a footer separator ("|", "·", "•") or a line/block break
    separates it from the keyword, so a promo's "Use your code at checkout." next to "Order
    48291374" stays a promo. In the keyword's own sentence it still counts ("Your security code
    for booking 482913", "Verification code for phone 482913"), because masking it would leak
    real codes from retailer sign-in mail. Accepted price, erring toward minimising: a promo
    that puts a labelled number in the same sentence as "your code" ("Use your code at checkout,
    order 48291374 ships free", "Use your code in store 1234 or online", or a dash rather than a
    sentence end before "Confirmation number 48291374") is treated as an OTP, like the existing
    "Use your code at checkout and get 5000 points". Known misses, rare layouts the older masking
    also missed: a labelled code on its own line after the keyword's sentence or block has ended
    ("Your verification code is below." then "Store 482913"). Without a promo opening
    the full keyword list applies, as before;
  - a **reset keyword in the body plus a password-reset link** (link text or path) wins over body
    promo tokens too, so a reset under a "Women · Men · Sale" nav bar with a neutral subject
    ("Account recovery") is still a reset. The price: a newsletter whose body says "forgot your
    password?" next to a reset link is minimised. Magic-link/verify mail gets no such exemption
    ("confirm your email and get 15% off" welcome promos stay promos);
  - for the other kinds (reset without such a link, magic link, alerts) body promo tokens count
    only in the **first 200 characters after the hidden preheader**, and not at all when the
    **subject** states the security purpose ("Reset your password" under a nav bar is still a
    reset);
  - promo footers never count.
- Login/security alerts whose **subject** is explicit need no link or code; body-only alerts need
  one. Subject matches outrank body matches.
- Email-address/account verification with a link → reason `magic_link`; with a code → `otp`.
  In the type cascade, OTP and magic link both map to the subtype `verification_code`.

## Type cascade (§7.3)

- **The user's `type_override` is applied before the rules** (except security detection, so that
  minimisation always holds). At step 15 it could never take effect while the rule that caused
  the correction keeps firing.
- "Confident" = rule confidence ≥ 0.6. Weaker matches only feed the provisional type for
  `typeSource: "pending"`. Without one, the Gmail category decides; failing that, `other`.
- **Primary purpose (CAN-SPAM)**: the subject and the first ~600 characters decide. Promo footers
  add `secondaryTags: ["promotional"]`. Subjects that state another purpose (welcome, trial,
  what's new, terms/privacy/plan, onboarding) are not promotional even if the body sells.
- **Transactional subtypes**: payment_failed > shipping > billing > travel/ticket, so a shipping
  notice that contains an order summary is still `shipping` (importance 40 for 14 days).
  **Payment-failure wording needs no amount.**
- Bare "your order" in a subject ("20% off your order") is not billing evidence.
- Travel needs confirmation wording or a booking reference, so airline promos stay promotional.
- **Calendar parts**: METHOD:REPLY → `notification/activity`. A calendar part on a clear travel
  confirmation → `transactional/travel` with `secondaryTags: ["event"]`.
  FoodEstablishmentReservation → `travel`; EventReservation → `ticket`.
- **Added event rule** after the survey rule (webinar / RSVP / event reminder wording), so
  `event` subtypes are reachable without a calendar part or schema.org markup. It yields to
  promotional subjects and to newsletter subjects.
- Newsletter platforms (Substack, beehiiv, Ghost, Buttondown, Kit) and long editorial content beat
  `CATEGORY_PROMOTIONS` (Gmail puts many newsletters there). Sponsor slots don't make a
  newsletter promotional.
- Community needs List-Post or mailing-list software, or List-Id/Forums plus forum wording.
  Developer/work tools (GitHub, Jira, Slack …) are excluded, because their List-Id mail is
  notifications.
- Notification step: "auto-generated" is read as Auto-Submitted, a no-reply sender, or a known
  work-tool domain.
- Social subject rule uses only unmistakably social phrases (followers, friend/connection
  requests); "mentioned you" is a notification.

## Importance (§7.5)

- "Others 15–25": transactional (non-shipping/non-failed) 25, trial_ending 25,
  notification mention/reminder 25, other notifications 20, account_notice 20, the rest 15.
- OTP/reset: base 15 + boost 45 until +1 h. Shipping: base 25 + boost 15 until +14 d.
  Deal/deadline: +20 until the deadline, only for engaged senders (read rate ≥ 0.3 or positive
  bias) and only inside the 48 h window. "High-frequency never-opened" = read rate 0 and
  ≥ 3 emails/week.
- **Suspicious mail**: no positive adjustments and capped at 59 (never "high"); it surfaces via the
  Suspicious view instead. **Guardrail**: LLM-sourced `account_security` / `payment_failed`
  without DMARC pass is capped at 59 (`guardrail:dmarc_required`). A label from the per-template
  cache (`template_cache`) is Claude's cached answer, so it counts as LLM-sourced: otherwise one
  prompt-injected email would label its template and every later email of it would skip the cap.
  A **sender-prior** label (`sender_prior`) counts too: the prior is a majority vote over the
  sender's stored types, which include those Claude and template-cache labels, so after a handful
  of cached emails the prior would otherwise take over (step 15 runs before step 16) and carry the
  injected label past the cap. Real security mail is caught by the confident rules first, and
  legitimate security senders pass DMARC, so only a rule or the user's override skips the check.
- **Exact decay**: boosts are applied latest-expiring first, and each reason records the points it
  actually added after clamping. `effectiveImportance` therefore reproduces a fresh computation
  exactly (a randomised test checks this).
- `expiresAt` is the earliest time the stored score changes: a boost expiry, **or the moment a
  future deadline enters its 48 h window**, so maintenance re-scores then.

## Trust badge (DESIGN-SCORE §9)

- `failed_auth` = DMARC or DKIM fail **unless Gmail reports `arc=pass`**. §7.8 excludes exactly
  that forwarded/list mail from "Suspicious"; flagging every mailing-list message as possible
  spoofing would flood Needs attention. Such mail is `partial` with `dmarc` missing.
- "Commercial" = subscription and not transactional/account_security/account_notice (the
  footer-check applicability rule). `missing` always lists every missing item (dmarc, one_click,
  unsubscribe, postal_address). The state follows the spec: trusted = DMARC pass (+ one-click if
  commercial).

## Content extraction

- **Single parse**: cheerio with parse5, then one iterative walk (no recursion). Documents are
  truncated at 2 MB, and **nesting beyond 400 levels is flattened by a linear pre-scan**: parse5
  is quadratic in depth (20k nested `<div>` ≈ 5 s CPU). `rp`/`rt`/`rb`/`rtc` count toward the depth
  (they close implicitly only inside `<ruby>`; 20k stray `<rt>`s took 22 s), and at most 16
  formatting elements (`a`, `b`, `font`, `i`, …) stay open: parse5 re-opens every unclosed one in
  each new block, so 420 open `<b id=N>` over 30,000 paragraphs exhausted the heap. Extra ones only
  carry styling, which extraction does not use. A 1 MB hostile document now parses in ≈ 2.6 s.
- Hidden content: `display:none`, `visibility:hidden`, `opacity≈0`, `font-size<2px`, zero height or
  width with `overflow:hidden`, off-screen positioning, `clip:rect(0…)`, transparent text, the
  `hidden` attribute, and classes hidden by **top-level** `<style>` rules (rules inside `@media`
  only hide conditionally, so they are ignored). `mso-hide:all` alone only hides from Outlook, so
  it doesn't count.
- The preheader is all hidden text before the first visible text. `visibleText` is preheader +
  body, block-separated, head-truncated at 4,000 characters. Footer detectors (postal address,
  receiving statement) run on the full text.
- **CTA labels**: button-like anchors (background/border + padding/box, btn/button/cta classes,
  role=button, bulletproof coloured cells), plus image links whose shape and alt text/file name
  suggest a button (logos excluded). Labels are NFKC, lower-cased, trimmed of arrows/emoji, ≤ 7
  words. Unsubscribe, preferences and view-online links are excluded.
- Unsubscribe links: link text (17+ languages), "click here" when the preceding text says
  unsubscribe, the same host plus path (or first two path segments) as the List-Unsubscribe https
  URI, unsubscribe-like paths, or mailto. For plain-text mail, the words before a bare URL decide.
- **Language**: franc-min on ≥ 20 words, restricted to languages franc-min models well and that
  plausibly occur in a personal inbox. Low-resource languages that short English is often mistaken
  for are excluded. franc-min has no Danish, Norwegian or Finnish model (known limitation; those
  read as a neighbouring language or null).
- **Deals**: expiry precedence is schema.org end > nearest text expiry (≤ 400 characters) >
  email-level expiry > undated (+14 d, confidence 0.2). Date-only → end of that day in the
  **sender's** timezone (from the Date header offset). "Midnight" at 00:00 → end of that day.
  chrono windows never cross a line break. Stale JSON-LD ends (before receipt) are ignored.
  Codes need a letter, must follow a code keyword (or "use/enter/apply CODE" with a digit or "at
  checkout"), and are rejected when they look like reference numbers, follow
  order/tracking/verification/zip wording, match schema.org order/tracking numbers, or are
  ordinary words. Deals are also extracted from receipts (footer offers are real). The pipeline
  may hide deals for `account_security`.
- **Deadline**: structured dates (calendar DTSTART, schema.org start/due dates) win over text
  dates, which lack a reliable timezone. The window is receipt − 1 h … receipt + 180 d.
- **Simhash**: set semantics over DOM-skeleton shingles (the last three layout tokens on the path).
  Layout tokens are table/tr/td/div/section… with up to two human-named classes and the table
  width. Text blocks (p, h*, lists) are a single token whose inner structure is ignored; text,
  URLs and inline formatting are ignored. Repeated rows don't move the hash; redesigns do.
  Plain-text mail hashes line shapes.

## Policy (§6.3, §7.6)

- Tracker lists are our own, written from vendor documentation. They are not derived from
  Disconnect or DuckDuckGo lists. "Tracker-exclusive" hosts never serve content images; vendors
  that also host content (SendGrid's image CDN, customer.io images, substackcdn) are handled by
  pixel path + size instead.
- **Per-recipient detection**: the address (plain, URL-encoded, base64/base64url at any byte
  alignment), MD5/SHA-1/SHA-256 hex, or a ≥ 24-character high-entropy token. **Not** flagged in
  paths: hex runs and UUIDs (asset fingerprints, e.g. `logo.3f9a….png`), human slugs, wordy
  camelCase file names, and anything on a small allowlist of static-asset CDNs. **Hex tokens in
  query values are flagged** (subscriber ids are often hex). An over-long URL (> 4 KB) is treated
  as per-recipient. The trade-off is documented: a per-recipient hex id in a *path* is missed
  unless the pixel rules catch it.
- **Signed CDN URLs (`STATIC_SIGNED_URL_PARAMS`, 2026-09-29):** LinkedIn's media CDN needs its
  `t` parameter (43 base64url chars, one 32-byte HMAC over the path and expiry), which the token
  check flagged, so every LinkedIn profile photo and post image was dropped. `t` is exempt only on
  `licdn.com`, only under that name and only in exactly that shape; the address/hash checks still
  run. Checked on 14 real LinkedIn emails: a photo carries the same `t` in every email and day.
  Known miss (not fixed): MoEngage asset names such as
  `image-ap1.moengage.com/<app>/2025…YTOK7V…pngcomp<app>.png` read as a token, so those logos
  keep only their alt text.
- **Gallery audit false positives (2026-09-30).** A browser audit of every real email loaded as
  its gallery card found 10 cards whose visible images were dropped below the card cap. Each was
  traced to the exact rule (throwaway script over the raw MIME, nothing kept) and decided:
  - *Fixed — ESP asset-library uploads (`STATIC_ASSET_UPLOAD_PATHS`).* Customer.io serves a
    workspace's uploaded images from `userimg-assets(-eu).customeriomail.com/images/client-env-<n>/`
    under a ULID name (26 Crockford base32 characters), which the token check read as
    per-recipient: Supabase's newsletter lost all 9 content images, Lovable its logos. Exempt:
    exactly those two hosts and that one path shape (one file under `client-env-<digits>/`); the
    query, the address/hash checks and the pixel rules still run, and the rest of
    `customeriomail.com` (which also carries tracking) keeps the token check. Customer.io's open
    pixel lives on the sender's branded host as `/e/o/<token>` and stays a pixel.
  - *Fixed — Marketo Design Studio images (`STATIC_ASSET_UPLOAD_PATH_SHAPES`).* Marketo serves
    uploaded images from `/rs/<Munchkin id NNN-AAA-NNN>/images/<file>` on the customer's own
    landing-page domain; JetBrains' consonant-heavy `logo_jetbrains_blackandwhite_72x72@2x.png`
    (vowel ratio 0.33, one 13-letter part) read as a token on 4 cards. Matched by path shape on
    any host (the host is branded), one file below `images/`; query and address checks still run.
    Like every shape rule it could be imitated by a sender set on evading, as a hex path id already
    can (the trade-off above).
  - *Fixed — dated file names (`DATE_IN_NAME`).* `WhatsApp-Image-2026-08-13-at-11.51.56-AM_….jpeg`
    failed the human-slug rule only because the date's three numeric parts outnumbered its words.
    A separated calendar date (19xx/20xx-MM-DD, one repeated `-` or `_`) is now left out of the
    slug count: it is neither a word nor noise. It can't unlock a random part: the remaining parts
    must still be ≥ 2 short words and numbers, and the length and entropy checks still run on
    the whole piece (a `2026-08-13-<random>` token is still a token, tested).
  - *Fixed in the viewer — hidden copies (apps/web view-source.ts).* Microsoft's dark-mode logo
    swap writes the same logo URL twice: shown, and hidden inline (`display:none`) for the email's
    CSS to reveal. The hidden occurrence failed the hidden-style pixel rule and lost its src while
    the shown one loaded, so wherever the CSS revealed it the card had an empty logo. A pixel
    decision for an occurrence of a URL that another occurrence of the same email already loads
    now reuses that token: the URL is fetched either way, so it adds no request and tells the
    sender nothing. Only `pixel` decisions (the attribute-level rules) can differ between
    occurrences; tracker-host and per-recipient decisions are per URL. A hidden-only URL still
    stays unloaded (Microsoft's white logo, Lovable's `Black@2x` dark variant): a hidden image with
    a short id is exactly how a tracker hides, and a short id escapes the per-recipient check.
    Known limitation: in dark mode those revealed dark variants show as an empty box (the card
    paints no alt text for them).
  - *Kept (known misses, too close to a real token to exempt safely):* a 40-character random S3
    upload name (`…/logo/<40 random>.png`, Laravel's `hashName`, Techkraft), and a random suffix on
    a generic CloudFront upload name (`…/uploads/images/75x75/<uniqid>_organisation_image-<29
    random>.png`, 2 Unstop cards). Only a per-sender host allowlist could let these through.
  - *Kept (correct):* Facebook's per-message signed CDN URL (`scontent….fbcdn.net/…?_nc_ohc=…&_nc_oc=…`):
    opaque ids minted when the email was sent, which can't be told from a per-recipient one
    (unlike LinkedIn's `t`, verified identical across emails). The remaining 3 cards (Google,
    2 × Unstop) were not policy removals: CSS background images use card slots too, and the old
    6-image cap ran out (fixed by the card cap, apps/web view-source.ts CARD_MAX_IMAGES).
- **Expired signed URLs (`isExpiredSignedUrl`, not a privacy rule).** LinkedIn's media CDN signs
  an expiry `e` (unix seconds) into every `media.licdn.com` URL and refuses the URL once it has
  passed; post and article images carry an `e` a few weeks out, so older digests are full of dead
  images (on a sampled digest every failing URL had `e` in the past and every loading one in the
  future). Skipping them took the audit's 187 image-heavy cards from 357 grey placeholders to 63.
  The viewer no longer proxies them: no grey box, no wasted `/img` request, no card slot. `imageFetchDecision` is
  unchanged (the analysis pre-fetch can adopt it separately).
- `extractImageRefs` uses a linear tag tokenizer instead of a DOM library, so importing
  `@edf/core/policy` stays cheap for the image proxy. It decodes common character references in
  attributes and skips @font-face/@import URLs.

## LLM request pieces (FREE-TIER.md §6.2)

- `llmClassificationJsonSchema` is the Zod schema's JSON Schema with the keywords that Claude
  structured outputs reject removed (`$schema`, numeric/string bounds). `confidence` is clamped
  client-side in `parseLlmClassification`, which also nulls subtypes that don't belong to the
  type.
- `buildClassifyUserContent` refuses security-sensitive and non-automated mail. It removes
  URLs/emails/angle brackets from untrusted fields (so the data block can't be closed from inside),
  redacts codes, and caps the text at 1,500 characters.

## Things the orchestrator must know

- Import `@edf/core` lazily inside steps: cheerio's main entry loads undici and parse5
  (~120 ms cold). `@edf/core/policy` does not load cheerio.
- For security-sensitive mail, store `redactSensitive(subject)` (§7.4: codes removed from
  anything stored), `snippet = NULL`, and index via `buildSearchText({ securitySensitive: true })`.
