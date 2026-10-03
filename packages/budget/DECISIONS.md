# @edf/budget — implementation decisions

Where FREE-TIER.md §7–§8 was ambiguous or silent, we chose the reading that keeps the app from
crossing a vendor's hard limit (under-counting is how free tiers get paused). Each entry names the
spec section and the reason.

## Sandbox actions (§5.3, §8.3)

- **At the self-cap** (70% of any Sandbox hard limit): samples off **and** planned renders off,
  i.e. only the owner's on-demand renders run, on every trigger (`render/requested` too).
  "Your on-demand only" is read the same way as at global L2.
- **A paused on-demand request is refused, not queued.** While the governor pauses a user's
  renders (L3 or `rendersOff` for everyone; L2 or the Sandbox self-cap for friends), "Analyze" and
  "Run AI review" queue nothing and use none of the day's allowance; they return the reason, and
  the email page shows it. A request queued before the pause stays queued and runs when renders
  resume. The rule is `onDemandPausedReason` in `render-pause.ts`: it lives here, not in
  @edf/pipeline, so the email page and the Analyze action don't load the whole pipeline.
- **"Then static-only"** has no threshold in the spec: rendering stops entirely (`rendersOff`,
  also set at L3) at **90% of any Sandbox hard limit** (`sandboxStaticOnlyFractionOfHard`), so the
  owner's own on-demand renders can't push the Sandbox into the vendor's 30-day creation pause.
- The planner applies these switches, and `renderForUser` re-reads the governor before it creates
  a VM (a plan can be minutes old). Queued `fill` / `exemplar` requests are only picked while fill /
  samples are allowed, so re-queued work waits instead of rendering past the switch.

## Fast Origin Transfer (§8.1)

- One resource code, `vercel.fot_mb` (MB), written from exactly two places:
  - **edf-app's own large responses**, through the meter (`recordOriginBytes`): the view-source
    HTML counted **twice** (edf-app → edf-view, then edf-view's `/v` page), metered in the
    `/api/view-source` request itself, and export pages. Small responses (pages, JSON) are left to
    the weekly `vercel_fot` calibration.
  - **Viewer images, from edf-view's exact byte reports**: `/api/view-stats` adds each report's
    `img_bytes_served` (every `/img` response body edf-view's function sent; CDN cache hits never
    reach it and are Fast Data Transfer, not Origin) to `vercel.fot_mb` in the same transaction as
    the report's audit row and its `view.*` diagnostic rows (apps/web `service-counts.ts`).
- **Image allowances are no longer metered at mint time** (neither gallery cards nor full views).
  The signed `mb` of an image token stays what edf-view enforces, but as a meter it was an upper
  bound far above reality: a gallery card minted ≈ 1.5 MB (then 6 images × ≤ 384 KB, the whole
  allowance for any email with 4+ images; since 2026-09-29 6 × 1 MB, see below) where edf-view
  really serves ≈ 0.3 MB (~5× less), and a
  full view up to 15 MB where a typical opened email serves ≈ 0.8 MB (20 images × ~40 KB). Metering the bound wasted
  ~80% of the free FOT allowance and pushed the governor into images-click-to-load after about
  three gallery visits a day, which ruined the gallery, the app's main screen.
- **The loss is bounded, and the calibration covers it.** edf-view's counts live in instance
  memory until reported, so an instance recycled before it reports loses what it has not sent.
  Reports ride on requests (in the background, under `waitUntil`, so no response waits): one goes
  out once 60 s have passed since the last, **or as soon as 4 MB of served image bytes are
  pending**, never twice within 10 s per instance (apps/view `stats.ts`; at most one database
  write per 10 s per instance). That alone assumes follow-up traffic, which a few users rarely
  send: a gallery loaded right after a cold start serves its ≈ 9 MB of card images within 10 s and
  then often nothing more reaches that instance (`v.js` and `img.js` are separate functions with
  separate counters, so only a later `/img` request would carry the bytes). So **while served image
  bytes are pending, edf-view also schedules one delayed report 12 s later** under the `waitUntil`
  of the request that served them (the only timer; it stands down if a report goes out first, so
  the 10 s spacing holds, and 12 s + the 3 s report timeout stays inside the functions' 30 s
  `maxDuration`, which bounds `waitUntil`). The price is that an image instance stays alive ≈ 12 s
  after its last burst: ≈ 2 GB × 12 s ≈ 0.007 GB-h a burst, ≈ 6 GB-h a month at 30 idle-ending
  bursts a day (< 2% of the 360 GB-h). It runs after a user's own requests, so the database is
  awake anyway. Counts are then lost only when a report fails and no later image request reaches
  the instance (a failed report re-queues its counts for the next one), or the instance dies in
  the middle of a `waitUntil`. The default **`vercel_fot` calibration factor is 1.25**
  (`FREE_TIER_PROFILE.defaultCalibration`): the governor counts every metered MB as 1.25 MB, a
  25% allowance for such losses and for the small responses nobody meters. Keys missing from
  `app_setting.calibration` (the seeded row has none for `vercel_fot`) fall back to the profile
  default in `calibrationFactor`; the weekly reconciliation with the dashboard replaces it with a
  measured factor, and the week-1 check must confirm the reports track the dashboard's Fast
  Origin Transfer for `edf-view` (if they fall short, raise the factor).
- **Exactly once:** `/api/view-source` meters only its HTML; images are metered only from the
  reports. `img_card_bytes_served` is a subset of `img_bytes_served` (edf-view adds a card
  image's bytes to both), so it is never added on top (a report carrying only the card count
  would still meter those bytes: the larger of the two). A failed report is re-sent with its
  counts; the only double count possible is a report edf-app committed whose answer edf-view
  never received, which errs high.
- **Revisits:** a card re-minted after its URL went stale (200 s) meters its HTML again; its
  images usually come from the browser or CDN cache and are then (correctly) not metered.
- **Card image allowance: 1 MB per image, no even split (2026-09-29).** The card cap (then
  384 KB, and 1.5 MB shared by 6 images, i.e. 256 KB each) replaced ordinary hero images with
  edf-view's grey placeholder: on 117 real cards (471 images) it greyed out 8 heroes of
  263 KB–986 KB, the most visible part of those cards. Now each of a card's ≤ 6 proxied images may
  be up to 1 MB (`CARD_IMAGE_MAX_BYTES`; `CARD_BUDGET_BYTES` = 6 MB; since 2026-09-30 up to 20
  images share it, see "Card image cap" below), which fits every image
  in that sample except two 4 MB PNGs (then over any view's 2 MB image cap; a full view now
  allows 5 MB, see "Full-view image cap" below). Metering is unchanged
  (served bytes only), so the cost is only what those images really weigh: ≈ 4.7 MB more across
  the 117 cards, ≈ +40 KB per card on average (the median card serves ≈ 8 KB of images, the mean
  ≈ 0.1 MB, well under the ≈ 0.3 MB the FREE-TIER.md §8.4 gallery sizing assumes). The worst case
  per card rises from 1.5 MB to 6 MB served, still metered and still stopped by the governor's
  image switch (cards go `noimg`).
- **Card image cap: 20 images, the 6 MB total unchanged (2026-09-30).** A ground-truth audit
  (all 618 real emails loaded exactly as their gallery cards load them) found 177 cards with
  images inside the card's visible part left without a src by the 6-image cap (1–10 per card on
  top of the 6; LinkedIn digests, job boards, shops; CSS backgrounds use slots too). The cap is now
  20 (`CARD_MAX_IMAGES`): re-measured on the 187 affected cards, the deepest image inside a
  card's visible part needed slot 20 on 4 cards and at most slot 18 on all others, and none was
  left out by the cap any more. The total stays 6 MB (`CARD_BUDGET_BYTES`, now a constant instead
  of 6 × the per-image 1 MB) and the signed allowances never add up to more:
  `cardImageAllowance` gave a card with ≤ 6 images 1 MB each (as before) and a card with more
  1 MB for each of its first 4 images (header and hero, where the big images are) and an even
  share of the other 2 MB for the rest (≥ 128 KB each at 20; replaced on 2026-10-01 by a split by
  displayed size, "Card image allowance by displayed size" below). Checked against the real sizes of
  those cards' 2,101 images (measured once with every image allowed 1 MB): 19 exceed their share
  (4 of them inside the visible part: 3 product shots of 179–324 KB in one shop's cards and one
  518 KB image at slot 6), against 8 for a plain 6 MB ÷ n split, which instead greys out heroes
  (a 416 KB hero at slot 1, a 701 KB image at slot 3), the most visible part of a card. Cost,
  measured on the 187 image-heavy cards: ≈ 188 KB of images served per card on first view, of
  which ≈ 52 KB are the first 6 images (so ≈ +136 KB for those cards), ≈ 11 `/img` requests per
  card (≤ 20). Over all 618 real cards: ≈ 113 KB served per card on average (median 19 KB, 90th
  percentile 385 KB, largest 1.3 MB), of which ≈ 55 KB are the first 6 images, so ≈ +58 KB per
  card, and 6.5 `/img` requests per card instead of 3.6: still well under the ≈ 0.3 MB per card
  the FREE-TIER.md §8.4 gallery sizing plans with. Still metered from edf-view's byte reports only, and still stopped by the governor's image switch (cards go `noimg`).
  The split needs the exact number of images the card proxies, and the first estimate (from
  `extractImageRefs`) can be off: it sees only a URL's first occurrence (a hidden dark-mode copy
  before the shown logo), stops at 2 MB of HTML, and counts images the sanitizer drops. Sized too
  low, the budget ran out before the cap (a 7th image got no src; a later one a few-byte allowance,
  i.e. a grey placeholder and a wasted fetch). So the render records the URLs it really proxies and,
  when that changes any share (or a full view's budget runs out early), `/api/view-source` re-mints
  from that count and renders once more; it never mints a partial allowance.
- **Full-view image cap: 5 MB, the 15 MB per email unchanged (2026-09-30).** A visual audit of 625
  real emails found one-picture mailers (one sender, 14 emails) whose only image, a 3.2–7.9 MB
  PNG, was a grey box in the opened design, because a full view's image tokens allowed 2 MB. Now
  `IMAGE_TOKEN_MAX_BYTES` is 5 MB (@edf/crypto, mirrored by edf-view, which also raised its
  per-response backstop `MAX_IMAGE_RESPONSE_BYTES` from 4 MB to 5 MB, the SSRF-safe fetcher's own
  limit; over Vercel's 4.5 MB body limit, which binds only functions that don't stream:
  FREE-TIER.md §8.4 item 3 has the reason and the week-1 check). The even split is unchanged
  (`min(5 MB, 15 MB ÷ n)`), so up to 3 images get the whole 5 MB and 8 or more get what they got
  before. (Replaced on 2026-10-01 by a split by displayed size that never gives an image less than
  its card does, with the same 3 × 5 MB and 15 MB ÷ n for alike images: "Card image allowance by
  displayed size" below.) Checked through the local viewer on all 17 of that sender's emails: 9 heroes of
  3.2–4.8 MB now show (each served in < 1 s), the 5 over 5 MB (5.3–7.9 MB) and a 5000 × 6250
  PNG (31 megapixels, over the fetcher's 25) keep the placeholder. The audit found no other image
  over 2 MB. **Fast Origin Transfer:** the worst case per first view of an email stays 15 MB (it
  now takes 3 images of ≥ 5 MB instead of 8 of ≥ 2 MB); still metered from edf-view's byte reports
  only. Measured: the engine's full views load ≈ 0.155 MB of images per email on average; the 9
  newly shown heroes (37.8 MB) add ≈ 0.06 MB, so ≈ 0.215 MB per opened email, under the ≈ 0.4 MB
  (about 10 images) FREE-TIER.md §7 plans with. At §7's usage that is ≈ 97 MB a month for the
  owner's 450 opens (was ≈ 70 MB; ≈ 121 MB counted with the 1.25 factor), ≈ 32 MB for a friend's
  150, ≈ 0.7 GB (≈ 0.9 GB counted) for the owner plus 19 friends, against the 4,800 MB soft level.
  Worst month for this shape, every open a 5 MB one-picture mailer: owner ≈ 2.25 GB (≈ 2.8 GB
  counted); owner plus 4 such friends ≈ 5.25 GB, which the image switch stops as before (friends'
  images click-to-load at 4,800 MB, everyone's at 6,000 MB). **Cards stayed at 1 MB per image**
  (`CARD_IMAGE_MAX_BYTES`): the large images the audit found are these mailers' heroes, and at 5 MB
  each such card would serve ≈ 4.2 MB per first view, ≈ 38× the measured card mean of 0.11 MB, so
  a gallery page of that sender's 17 cards (a sender filter) would serve ≈ 39 MB of images instead
  of ≈ 12 KB, and a card shows the picture at half size anyway. (Revisited on 2026-10-01: a card
  may now give one image up to 5 MB within the same 6 MB, and that sender page costs ≈ 36 MB on
  its first view a day; "Card image allowance by displayed size" below.)
- **Expired LinkedIn images are not proxied (2026-09-30).** `media.licdn.com` URLs whose signed
  expiry `e` has passed can only fail (@edf/core `isExpiredSignedUrl`); proxying them served a grey
  placeholder, used a request and a card slot. Skipping them took those 187 cards from 357 grey
  placeholders to 63, and saves their `/img` invocations. (Since 2026-10-01 they show edf-view's
  static "Picture unavailable" image, `/img/unavailable`, instead of no src: still no token, no
  card slot, no fetch; one cached request per browser and day. See the next entry.)
- **Card image allowance by displayed size, and an honest placeholder (2026-10-01).**
  *Audit.* The crop audit (packages/render `crop-audit.mts`: all 630 real gallery cards loaded
  exactly as the gallery loads them, recording every `/img` answer, each image's allowance and
  whether it shows in the card's visible part; the real size of every image edf-view refused was
  measured apart) found 64 cards with a grey box or a broken picture inside the visible part
  (74 images). 31 of them were allowance failures (38 visible images, from the real sizes): a
  one-picture mailer's 3.2–4.7 MB PNG hero that, alone in its card, got 1 MB (9 cards; 5 more are
  5.0–7.5 MB, over any view's cap); 600 px product shots of 190–560 KB at slot 5 and later that got
  146–228 KB (an even share of the last 2 MB); GIFs and PNGs of 1–2 MB (Booking, Canva, Supabase,
  Google One) at 1 MB. The others were gone at the source (LinkedIn avatars and logos answering 403
  or 404), over 25 megapixels, an SVG, or the sender's own 1 × 1 image (below).
  *The split* (apps/web `cardImageAllowances`, solved by `shareBudget`): every image a floor of
  min(128 KB, 1.5 MB ÷ n) (`IMAGE_FLOOR_BYTES`; a quarter of the budget once n > 12: 75 KB each at
  20), so the small images later in a digest still load; the rest of the 6 MB shared in proportion
  to each image's declared display area (`imageDisplayArea`: width × height from its attributes or
  inline style, at most 800 px wide, ¾ of the width when the height is missing, 150 × 150 when
  nothing is declared, as for a `<style>` background) times a slot weight (`cardSlotWeight`: 1 for
  the first four images, then (4 ÷ slot)^1.25: 0.76, 0.60, 0.50, … 0.13 at slot 20), each image up to the full
  view's per-image 5 MB (`IMAGE_TOKEN_MAX_BYTES`), what a capped image can't take shared again
  (water-filling). Nothing about an image's real size is known before edf-view fetches it, but how
  large it is drawn predicts it (heroes, banners and product shots are drawn large; avatars, icons
  and logos small), and a card shows only the top of the email: in the audit an image in slots 1–4
  was inside the card's visible part 81–88% of the time; relative to that, slots 5–9 0.76, 0.61,
  0.51, 0.45, 0.32, slots 10–12 0.33–0.38, from slot 13 ≤ 0.13, which the curve follows. The slot
  weight decides between images declared alike (a logo first still doesn't take the hero's share:
  their sizes decide that). Chanty declares every picture by its width alone (and its background
  wrapper by `max-width: 600px`), so by area alone its 600 × 89 header got the same share as the
  600 × 600 hero below it and as every 600 px picture further down, and its two heroes of 799 KB
  and 837 KB, which loaded under the old 1 MB for the first four, failed at 608–655 KB (the only
  visible images that split lost); with the slot weight they get ≈ 841 KB. A lone hero
  gets 5 MB; a 600 × 600 hero ≈ 4.9 MB beside a logo and four 100 px images, ≈ 4.5 MB beside a
  logo and 18 icons; three 600 × 600 GIFs 1.8, 1.8 and 1.1 MB beside 11 icons (≈ 112 KB each);
  6 alike images 1.1 MB for the first four, then 0.87 and 0.71 MB; 20 alike 595 KB for the first
  four down to 146 KB. The list must be exact, so `/api/view-source`
  estimates it from `extractImageRefs` (now with each image's declared size, and only the images
  the policy lets through) and re-mints from the rendered list whenever any share differs (too
  high or too low, in either mode; it still never mints a partial allowance). Chosen by replaying
  the audit's real sizes with the hints edf-app really sees (a first replay counted backgrounds in
  style attributes as unsized): visible allowance failures 38 on 31 cards (old split) → 25 on 22 (a
  plain 6 MB ÷ n) → 11 on 9 (by area alone, 2 of them newly failing) → 9 on 7 (× 4 ÷ slot, 1
  newly failing) → **8 on 6** (× (4 ÷ slot)^1.25; 24 images in all, visible or not, against 80;
  none that loaded under the old split fails); measured after the change: the same 8 on 6 (3 more
  cards came back budget-limited in that run, every image of them within its allowance: edf-view's
  per-email 15 MB-a-day ledger, spent by the day's repeated audit loads). What is left are cards
  whose large images
  together outgrow 6 MB (Betterbrand's 1.8 MB and 4.4 MB product shots drawn at 208 px; Booking's
  1.9 MB and 0.8 MB among 6.6 MB) and images declared alike, or not at all, but heavier than their
  neighbours (Grüns: one shot among 600 px images; Supabase's 2 MB GIF among unsized PNGs).
  *The opened email* (`fullViewImageAllowances`, the same day): a full view's 15 MB was split
  evenly over every image `extractImageRefs` found, including the trackers, pixels and expired
  links it never proxies, and re-minted only when that ran short, so a hero its card now gave up to
  5 MB got ≈ 1 MB when opened (Canva's 2 MB GIF, Booking's 1.4 MB collage and Google One's 1.3 MB
  hero showed in their cards and "Picture unavailable" in the detail view). Now the full view
  shares its 15 MB the same way, from the exact list of images it proxies: each of the first 20
  (the card's, in the same order) starts from what its card gives it, so opening an email never
  shows less than its card; the others from min(128 KB, 3.75 MB ÷ n); the rest in proportion to the
  declared side (√ area: the whole email is shown, so no slot weight, and 15 MB isn't tight, so it
  leans less on size), ≤ 5 MB each. Up to 3 images still get 5 MB each and n alike images
  15 MB ÷ n, as before. Replayed on the full views of all 630 emails (4,166 images, real sizes
  known): images over their allowance 9 (an even split over the proxied images only; the old
  estimate counted more) → 3 (Betterbrand's 4.4 MB shot, Supabase's 2 MB GIF on 2 emails), none
  newly failing, none that loads in its card but not when opened (by area instead of side: 4, and
  Booking's two 0.8–1 MB tiles newly failing). Its worst case is unchanged (≤ 15 MB per email, 60
  images, 5 MB each); what it spends grows by the images that now load: ≈ 8.6 MB over the 630
  emails' first full views, ≈ 14 KB per opened email (≈ 0.23 MB instead of ≈ 0.215 MB, under the
  ≈ 0.4 MB FREE-TIER.md §7 plans with; "Full-view image cap" above).
  *Worst case unchanged:* each token's signed `mb` is the hard bound (edf-view's per-budget ledger
  is per instance, a best-effort second layer) and a card's allowances still add up to at most
  `CARD_BUDGET_BYTES` (6 MB), over at most 20 images, each ≤ 5 MB (as a full view's): ≤ 6 MB per
  card, ≤ 180 MB per page of 30 cards, exactly as before. What changes is what is spent.
  *Fast Origin Transfer, measured* (the same 630 cards, first view, before → after): card images
  74.5 MB → 133.7 MB in all (128.2 MB measured, plus the 5.8 MB of the 3 budget-limited cards'
  images from their real sizes); per card mean 121 KB → 217 KB, median 20 KB → 22 KB, 90th
  percentile 389 KB → 491 KB, 99th 0.89 MB → 3.9 MB, largest 1.9 MB → 4.6 MB; `/img` requests
  6.53 → 6.64 per card. The mean is still under the ≈ 0.3 MB per card FREE-TIER.md §8.4 plans the
  gallery with (≈ 9.1 MB per page of 30 cards with their HTML twice, ≈ 11.4 MB as the governor
  counts it with the 1.25 factor), so its page counts to the soft level, the self-cap and L3 stand.
  The extra ≈ 96 KB per card on average (≈ +94 MB per 1,000 cards shown on first view) is mostly
  the pictures that used to be grey: that sender's 14 one-picture mailers (36 MB: a sender filter
  on them now serves ≈ 36 MB of images on its first view a day, instead of nothing), Grüns' heroes,
  Booking, Canva's 2 MB GIF. Still metered from edf-view's byte reports only, and still stopped by
  the governor's image switch (cards go `noimg`).
  *Placeholder:* an `<img>` that can't be shown now gets edf-view's "Picture unavailable" image
  (apps/view http.ts `UNAVAILABLE_SVG`: a soft light tile, a small picture icon and, where it fits,
  the words; a constant `image/svg+xml` with no script or external reference, served with the image
  CSP and nosniff, with the old GIF's 1 × 1 intrinsic size so no layout moves) instead of a flat
  grey box or, for an image with no src, the browser's broken-image icon and its alt text in the
  opened design: every failed fetch (gone at the source, over the allowance or 5 MB, over 25
  megapixels, not an image, a timeout, the budget used up; cached exactly as before:
  budget-limited answers stay `no-store`), and, as the static `/img/unavailable` (CDN- and
  browser-cached for a day), the `<img>` elements edf-app knows can't load (an expired signed URL,
  an unsignable one, one past a full view's 60-image cap). A CSS background (a style `url()` or a
  `background` attribute) edf-app knows can't load is dropped instead, as before, so the email's
  own background colour shows: drawn as a background, the 1 × 1 SVG either tiles into a flat light
  fill over that colour (hiding white text on a dark cell) or is scaled by `background-size: cover`
  to the box's larger side and cropped, icon and words cut off (the review found 68 such LinkedIn
  post and video covers on 25 cards; none after). A proxied background whose fetch fails still gets
  the SVG (a request can't tell a background from an `<img>`), as it got the grey GIF. Images
  blocked for privacy (trackers, pixels, per-recipient URLs) and those past a card's 20-image cap
  keep no src and stay invisible. After: 0 cards with a grey box; 93 cards show the placeholder
  inside the visible part (281 images: on 65 of them an expired LinkedIn avatar or logo that used
  to be an invisible gap, 22 images answering 404 or 403, 5 heroes over 5 MB, 1 over 25
  megapixels, 1 SVG logo, and the 8 allowance failures above on 6 cards; plus the 3 budget-limited
  cards above). The 3 cards the audit still flags show the sender's own 1 × 1 image (YouTube's
  transparent pixel over a video thumbnail that the privacy policy blocks as a per-recipient URL).
  One more card ("You logged into 8 Ball Pool", 2 images) shows edf-view's own tracker answer, its
  42-byte transparent GIF: `facebook.com` is on edf-view's tracker list (apps/view trackers.ts), so
  those images are blocked on purpose and stay invisible; the audit now counts that apart
  (`blockedTracker`), not as broken. edf-app's policy doesn't list `facebook.com`, so it still signs
  them real allowances (5 MB and 707 KB on that card) that edf-view never spends; under the split
  by size they take share from the card's other images (there: a static logo that loads anyway).
  Left as is: the two lists are separate layers (edf-view's is a second line of defence), and
  aligning them is a policy change in @edf/core. The placeholder's ≈ 2 KB is not counted in
  `img_bytes_served` (the 35-byte GIF wasn't either): 190 such answers over the 630 cards are
  ≈ 0.4 MB, 0.3% of the image bytes, left to the `vercel_fot` calibration like other small
  responses (counting them would let garbage-token requests from anyone schedule stats reports).
- `view.img_bytes_served` / `view.img_card_bytes_served` stay as `view.*` usage rows (with the
  other edf-view counters), as diagnostics for the weekly `vercel_fot` calibration.
- `recordImageBytes` remains on the meter but edf-app no longer calls it for minted tokens. The
  retired `img.bytes_minted` (bytes) code is not written.
- `view.unsignable_urls` counts image and link URLs a view dropped because the signer refused
  them. It is a diagnostic only, written with the next flush; the governor doesn't read it.

## Neon network transfer (§8.2)

- The spec names Neon transfer as a global resource but no writer (no usage API on Free). It is
  estimated from the bytes Postgres sent to edf-app's pool connections: the socket byte counter,
  read when a client goes back to the pool (`clientBytesReceived`). On a TLS socket that counter
  is the decrypted stream: protocol framing is included, TLS record overhead (about 3%) is not and
  is left to the `neon_transfer` calibration.

## Inngest executions (§2, §4.7, §8.1)

- Counted by client middleware (apps/web `execution-meter.ts`), as Inngest bills: +1 per run
  (`onRunStart`), +1 per `step.run` / `step.sendEvent` attempt (`onStepStart`; retried attempts
  count too, which errs high until the week-1 check in §13 says whether retries are billed), and +1
  for every other step kind (sleep, waitForEvent, invoke) on the request that follows its
  completion: the step is last on the executor's completed-step stack there, and the SDK never
  wraps it unmemoized. `runStep` no longer adds a step of its own.
- The run is counted only on a request sent to run the function from the top (`stepId=step`).
  Requests that run one of several parallel steps name that step, and their state is empty too, so
  `onRunStart` alone would count the run again for each of them.
- Counts still pending when an Inngest request ends (a sleep, a trailing sendEvent) are written
  then only while the database is awake (`databaseAwake()`); otherwise the next step's or UI
  flush writes them, so a metering write never wakes Neon.

## UI and machine-to-machine traffic (§8.1)

- One meter per server instance. Route handlers run in `withMeter("route")`; pages and Server
  Actions count one invocation and their GB-h (from the session lookup until the response is done,
  timed with `after()`) via `meterInvocation()`, and their CPU through the process-wide sampler at
  the next flush.
- Pages and Server Actions are counted in the `cache()`d session lookup (`getSessionUser`). Its
  GB-h is booked by an `after()` callback; the deferred flushes yield one macrotask first, so a
  flush scheduled by an earlier checkout in the same request still writes it.
- **Known, conservative: a revalidating Server Action counts 2 invocations** (and 2 overlapping
  GB-h spans). React's `cache()` memoizes only inside a render, and Next runs the action outside
  one, then renders the page in the same POST, so the session lookup runs (and meters) twice. An
  action that calls the session helpers twice also counts twice. This errs high, which is the
  safe side for a free tier, so it is left as is; a per-request dedupe would fix it.
- A UI flush runs after the response, at most every 60 s per instance and **the first time at
  once** (an instance may serve one request and be reaped), and only while the app used the
  database in the last minute, so metering never wakes Neon. It also writes the pool's checkouts
  to `neon_awake`. No request writes on its own account. Every meter's first UI flush runs at once,
  which the daily cron's one-off route meter relies on to write at all.
- **Trailing flush.** "Every 60 s per instance" (§8.1) would leave the last minute's requests in
  memory until a later request reaches the same instance, and lose them if it is reaped first:
  up to a minute of Fast Origin Transfer, the resource that pauses all three projects. So when
  requests (invocations or FOT) arrive inside the interval, one deferred flush per instance waits
  in `after()` until the interval ends and writes them then (still only while the database is
  awake). Keeping the instance up for that wait costs provisioned memory, so the wait is booked
  as GB-h (up to 60 s × 2 GB ≈ 0.03 GB-h per burst, and less when traffic overlaps it). A flush's
  own leftovers (its connection's transfer bytes) never start a wait.
- **A deferred flush never outlives its invocation.** Vercel gives `after()` / `waitUntil` work
  the function's own timeout and cancels it past the deadline (the request is then recorded as
  timed out, and nothing is written). The deadline is Vercel's `getDeadline()`, else the route's
  `maxDuration` passed to `meterRequest()` (view-source 30 s, export 60 s). **Known edge:** that
  fallback is measured from when `meterRequest()` starts, not from the start of the invocation
  (cold start and the route's setup come first), so it can be a little late. Only if the
  database also stalls and that head start is over `FLUSH_CUTOFF_MS` could the cutoff below land
  after the real deadline. `getDeadline()` is normally present on Vercel, so this is accepted as
  an edge case. The trailing wait ends
  `FLUSH_RESERVE_MS` (10 s, a new connection's timeout) before it and writes then, even inside
  the interval, so busy 30 s routes may write about every 20 s instead of every 60 s. With less
  than the reserve left, or no deadline known (local dev, a page with no Vercel context), nothing
  waits or writes: the amounts stay buffered for the instance's next flush. The reserve is
  sized for a normal write, not a bound on it: a stalled database (a held row lock, a slow
  connection) could outlast it, so a write still running `FLUSH_CUTOFF_MS` (1 s) before the
  deadline stops being awaited and `after()` settles in time. The abandoned write keeps its
  amounts accounted (it lands, or its failure puts them back in the buffer; the pool's 30 s query
  timeout ends it), and skips `neon_awake` (those checkouts wait for the next flush); they are
  lost only if the platform stops the instance first, the same loss as below. **Accepted loss:** if
  the instance is reaped before another request reaches it, the traffic buffered since its last
  flush is lost; that only happens after requests that ended within 10 s of their deadline (or
  where no deadline is known), and is at most one interval's traffic of that instance.
  Inngest requests can start a wait too (when invocations are still pending), bounded the same
  way by their 300 s deadline.

## Opus 5 friends' split (§6.4, §6.5 layer 3)

- "As the global cap gets close, the remaining budget is split equally among friends" is read as
  splitting what's left **after a hold for the owner**: `OWNER_MONTH_HOLD_USD` = $1.60, the owner's
  uncapped steady month from §6.4 (not scaled by G, like the table's "1 user" column). Each
  friend's month cap is at most `(0.9 × G − max(owner's reservations, hold)) / activeFriends`,
  which gives §6.4's figures: ≈ $0.15 at 20 users and G = 5, ≈ $0.39 at G = 10, and the $0.50
  (G/5-scaled) friend cap at 5 users. Holding the owner's full $3 cap would contradict those.
- The split alone can't protect the owner early in the month (friends reserve before the owner)
  or when more friends become active after others spent their share, so a friend's global cap
  passed to `reserve_llm` is `0.9 × G` minus the part of the hold the owner hasn't reserved yet.
  All friends together therefore stop at `0.9 × G − $1.60` until the owner has used the hold.
- At a small G (0.9 × G ≤ $1.60, i.e. G ≤ $1.78) the whole budget is the owner's hold and friends
  get nothing: the owner's on-demand reviews are priority 1 in §6.4. Owner caps are unchanged.
- The owner's reservations come from `llm_owner_month_reserved` (migration 0009), because a
  friend's tenant context can't read the owner's rows. Without that figure, `llmCaps` assumes all
  global reservations are the owner's for the split, and none of the hold as reserved for the
  global cap: conservative both ways.
- This replaces the older "remaining ÷ activeFriends" reading (packages/gmail/DECISIONS.md B8),
  whose share grew back as friends reserved and could be taken again and again.

## Opus 5 settlement (§6.5 layer 3, migration 0009)

- **Batch items settle exactly once, against their reservation day.** `ai_batch_item` records
  `reserved_day`, and the app marks an item settled (`settled_usd IS NULL` guard) in the same
  transaction as `settle_llm` and as saving the item's result. A retried or interrupted collection
  therefore never settles or applies an item twice, and a batch that ends after midnight UTC (or in
  the next month) is settled against the day and month it was reserved in.
- `settle_llm` releases at most what the user still holds for that day and month, and changes the
  global row by exactly the amount applied to the user's rows, so it can never release another
  user's reservation. It does nothing if the user has no rows for that day.

## Local development: platform usage is metered only on the platform (2026-10-01)

- **Why.** Locally (`pnpm dev`, Postgres in Docker, the Inngest Dev Server) the meter used to record
  the laptop's CPU, requests, memory, image bytes, database transfer and Dev Server executions as
  Vercel / Neon / Inngest usage. Browser automation and scripts then pushed the local governor to
  L2 and L3 (2026-09-29 and 2026-09-30: `vercel.cpu_s`), which switched off live gallery polling,
  planned renders and more, for usage no platform ever saw.
- **Rule** (`platform.ts`, `platformMetering()`; read from the process environment):
  - **Vercel** (`vercel.*`, and edf-view's `view.*` rows with its Fast Origin Transfer): only when
    `VERCEL` is set, i.e. on a Vercel deployment.
  - **Neon** (`neon.transfer_mb` and the `neon_awake` minutes behind `neon.cu_h`): on Vercel, or when
    `DATABASE_URL` is a Neon host (`*.neon.tech`: a laptop using a Neon branch really uses Neon).
  - **Inngest** (`inngest.*`): on Vercel, or whenever `INNGEST_DEV` doesn't select the Dev Server
    (read as the SDK reads it: "1", "true" or a URL). Without the Dev Server, requests can only come
    from Inngest Cloud, which bills them.
  - **`EDF_METER_LOCAL=1`** (apps/web env schema: "0" | "1", default "0") meters all three off
    Vercel too, exactly as before, to test the governor locally.
  - **On Vercel everything is metered, as before**: `VERCEL` alone turns every platform on, whatever
    else is set (production refuses `INNGEST_DEV` anyway).
  - **Production fails safe (2026-10-01, final review)**: Vercel sets `VERCEL` only while the
    project's "Automatically expose System Environment Variables" setting is on (Settings →
    Environment Variables; on by default). With it off, a rule that read `VERCEL` alone recorded no
    Vercel usage and the governor never throttled. So a **production build whose database is not
    on this machine** (`isHostedProduction`: `NODE_ENV=production` and `DATABASE_URL` not a loopback
    host or Unix socket; an unset or unparsable URL counts as hosted) meters every platform too,
    and edf-app's boot checks refuse to start such a deployment without `VERCEL`, naming the
    setting (the pool's suspend handling and two boot checks also read `VERCEL`). Why the database
    host: a Vercel function can never reach a loopback Postgres, so it can't mark a deployment as
    local by mistake, while `next build && next start` on a laptop against the Docker Postgres
    (NODE_ENV=production too) stays unmetered like `pnpm dev`. A local production build against a
    Neon branch is metered (the safe side; it is that branch's ledger, never production's). No
    opt-out switch exists on purpose: one copied into a Vercel project would silently switch the
    governor off again. edf-view and edf-keys meter nothing themselves (edf-view's counts are
    written by edf-app's receiver under this same rule).
- **Where.** The meter drops the amounts of a platform it doesn't meter in `add()` (`platforms`
  option, default `platformMetering()`), so every writer through it follows the rule: routes, pages
  and Server Actions, Inngest steps and the middleware's run/step counts, the daily cron's own
  meter, Neon transfer from the pool. `flushNeonAwake()` drops the checkouts when Neon isn't metered
  (its `platforms` argument has the same default; the step and cron call sites pass nothing).
  Amounts are validated the same way in every mode. The one direct writer of platform usage,
  `/api/view-stats` (apps/web `service-counts.ts`), checks `platformMetering().vercel` itself. The
  governor is unchanged: it reads the ledger, which now holds only real platform usage.
- **edf-view's `view.*` rows are Vercel-only too.** They count edf-view's Vercel functions (every
  `/v` and `/img` request, the bytes served), and the governor reads two of them
  (`view.view_requests`, `view.img_requests` in the external-load spike watch, `SPIKE_WATCH`), so
  locally they would raise `EXTERNAL_LOAD_SPIKE`. Keeping them would mean teaching the governor
  where it runs; not writing them keeps it identical everywhere. Nothing is lost for local
  debugging: every report's audit_log row (`action = 'view.stats'`, all counts) is still written,
  e.g. `SELECT sum((metadata->'counts'->>'img_bytes_served')::bigint) FROM audit_log WHERE action =
  'view.stats'`. The receiver decides for the reporter: a local edf-view reports to the local
  edf-app (`APP_ORIGIN`), and production accepts only Vercel-issued tokens.
- **Still recorded everywhere** (real usage, or app-level counters the governor's levels never
  read): `sandbox.*` (a Vercel Sandbox VM is real usage from a laptop too; locally `RENDERER=local`
  creates none), `anthropic.usd` and `gmail.units` (real API spend and quota), `keys.*` (edf-keys'
  audit counts; the System page warns on `keys.alert_unconfigured`), `backfill.started` (the 30-day
  import admission rule reads it), `render.fresh_cpu_s` (fresh batches' own Sandbox allowance,
  @edf/pipeline render-policy.ts; locally it counts the local renderer's time, so the cap behaves as
  in production) and `view.unsignable_urls` (edf-app's sanitizer diagnostic).
- **Known edges.** `vercel env pull` into `apps/web/.env.local` writes `VERCEL=1`, which turns local
  metering back on; remove it (packages/crypto DECISIONS D-C6 already requires that). Usage
  recorded while `EDF_METER_LOCAL=1` stays in the local `usage_ledger` (and the governor's stored
  level holds through its 24 h step-down, one level a day) until deleted. To reset a local database:
  `DELETE FROM usage_ledger WHERE resource LIKE 'vercel.%' OR resource LIKE 'neon.%' OR resource
  LIKE 'inngest.%' OR (resource LIKE 'view.%' AND resource <> 'view.unsignable_urls')`, `DELETE
  FROM neon_awake`, and put `app_setting.governor` back to its seed,
  `{"level":0,"since":null,"triggers":[],"belowSince":null}` (only deleting rows would leave the
  stored level to step down a level per 24 h); the next tick, or a `pipeline/kick` event, recomputes
  it.

## Tests

- The `render-gate` test lives here although it drives @edf/pipeline's planner. Tests of edf-app's
  metering, session lookup, view-source route and Inngest middleware live in apps/web/test
  (`metering.test.ts`, `inngest-meter.test.ts`) on that app's harness; this package imports no
  edf-app code.
