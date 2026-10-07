# Security implementation decisions

Covers `@edf/crypto`, `@edf/sanitize`, `@edf/fetch`, `apps/keys` (edf-keys) and `apps/view` (edf-view).
Where the spec was ambiguous we took the more secure reading that still works on Vercel Hobby.
IDs are referenced from code comments.

## Crypto (`packages/crypto`)

- **D-C1 GCM additional data binds the envelope header.** The byte formats are exactly as specified
  (`0x01 ‖ nonce ‖ ct ‖ tag`, `0x02 ‖ kidLen ‖ kid ‖ nonce ‖ ct ‖ tag`), and the GCM AAD is
  `header ‖ encodeAad(parts)` where `header` is every byte before the nonce. A version or kid swap
  can never be re-interpreted, even between two kids holding the same key bytes (tested).
  Anyone re-implementing the format must include the header.
- **D-C2 Default active kid uses natural order** (`v10` > `v9`), not plain lexicographic order
  (the stub said "lexicographically greatest"). This fixes a rotation foot-gun. Always set the
  active kid explicitly anyway (`TOKEN_KEK_ACTIVE`).
- **D-C3 Fail-closed inputs.** `seal`/`open` need at least one AAD part. Strings with lone
  surrogates are rejected, because their UTF-8 would be ambiguous. HMAC parts are strings or safe
  integers only, so `JSON.stringify` is canonical. Error messages never contain key material.
- **D-C4 Token lifetimes, checked on both sign and verify:**

  | Token       | Lifetime rule            | Clock skew                                  |
  | ----------- | ------------------------ | ------------------------------------------- |
  | View token  | `now ≤ exp ≤ now+300`    | none (both ends are edf-app)                |
  | Invite      | ≤ 30 days                | none                                        |
  | `/out` link | ≤ 30 days                | none                                        |
  | Image token | `x ≤ now + 14 days + 5 min` | 5 min; the 14-day ceiling is our own addition (48 h until 2026-10-07) |

  Other rules:
  - Signing refuses out-of-range `exp` values. For image tokens that means `now < x ≤ now + 14 days`;
    the 5 min skew is a verify-side allowance only. `imageTokenExpiry` rounds up to the end of the
    next 7-day period (tokens live 7–14 days), so an email's image URLs stay the same all week and
    a picture edf-view shrank is kept by the CDN and the browser instead of being fetched and
    shrunk again every day (it was a UTC day, 24–48 h, until 2026-10-07; daily re-shrinking would
    have spent much of Vercel's 4 h Active CPU). A leaked token still only proxies that one image
    for that user and email.
  - Invites: the MAC covers canonical JSON `["inv/v1", email, exp]`, and the email is trimmed and
    lower-cased.
  - Image tokens sign the exact canonical JSON bytes. On verify the signature is checked first,
    then the payload must be canonical. Only normalized URLs (`new URL(u).href === u`) are signed.
    Tokens are capped at 4 KB and URLs at 2 KB.

- **D-C5 OIDC verification** (`createOidcVerifier`, mirrored in edf-keys):
  - RS256 only (Vercel's documented algorithm); `alg: none`, HS256 key confusion and RS512 are
    rejected.
  - `iss`, `sub` and a single `aud` are pinned; `exp − iat === 7200` exactly; `iat` must not be in
    the future (`maxTokenAge`).
  - 30 s clock tolerance for `nbf`/`exp`. Without it, a freshly minted token would sometimes fail
    `nbf` across machines.
  - The JWKS URL comes only from `${issuer}/.well-known/openid-configuration`. The document's
    `issuer` must match exactly, and `jwks_uri` must be HTTPS on the issuer's origin.
  - Discovery is cached for 1 h, with a 30 s back-off after failures. Garbage and `alg: none`
    tokens never trigger network calls (tested).
  - The `jwks` override is refused in production-like environments.
- **D-O1 (orchestrator decision) Plain function tokens, no audience exchange.**
  - `@vercel/oidc` gets custom audiences by exchanging the token at `https://oidc.vercel.com/~token`.
    The exchanged token's lifetime is undocumented, so `exp − iat === 7200` might not hold for it.
  - So callers send the plain function token: the `x-vercel-oidc-token` request header, with
    `VERCEL_OIDC_TOKEN` as fallback. Nothing in this code calls the exchange.
  - Verifiers pin `iss`, `sub` (the calling project, `environment:production`) and
    `exp − iat === 7200`. The expected `aud` is a configured string; in practice it is the default
    team audience `https://vercel.com/<team>`.
  - Isolation between our three projects comes from the pinned `sub`.
  - Consequence: `APP_VIEW_SOURCE_AUD` is not used by edf-view at runtime.
- **D-C6 Dev-only helpers refuse production.** The dev OIDC issuer, the `jwks` override,
  `LocalKeyWrapper`, `gen-keys --dev` and both dev servers refuse to run when `NODE_ENV=production`,
  `VERCEL_ENV` is set to any value, or `VERCEL=1`. That includes `VERCEL_ENV=development` written
  by `vercel env pull`: remove it from `.env.local` for local development.
- **D-C7 DEK wrapping.**
  - `wrapped = seal(KEK, dek, ["edf/dek-wrap/v1", mailboxId, kekVersion])` (61 bytes), with
    `kekVersion = "keys:<kid>"`. The AAD binds mailbox_id and kek_version (§9.2), plus a purpose
    label.
  - `KeyServiceWrapper` refuses redirects, so the bearer token is never forwarded. It caps
    responses at 8 KB and validates every field's length and format.
  - `rewrapped` is `{wrapped, kekVersion} | null`.

## edf-keys (`apps/keys`)

- **D-K1 Stateless controls, per instance:**
  - A 10-minute sliding window.
  - Alert when unwraps plus generates reach 60, or refusals reach 20. Expected load is about 20
    refreshes an hour.
  - Hard limit of 120 operations per 10 minutes, answered with 429.
  - `KEYS_UNWRAP_ANOMALY` is opened or commented on at most once per 30 minutes.
  - These are best-effort layers behind the WAF rule. Thresholds are constants in `src/monitor.ts`.
- **D-K2 Order of checks:** method → path → declared size → OIDC → rate limit → content type →
  4 KB streamed body cap → exact-key JSON schema (canonical base64 only). An unauthenticated body
  is never read. The path check accepts only `/unwrap` (vercel.json rewrites it to `api/unwrap.ts`,
  and Vercel passes the original path, the same premise as D-V6), so direct `/api/unwrap` calls get
  404 and can't sidestep the edge rate limit. Verify on each new preview deploy that `POST /unwrap`
  with no token answers 401: a 404 means the function isn't seeing the original path (a 503 means
  the preview has no key settings; then check production right after promoting, SETUP.md step 9).
- **D-K3 Audit and alerts contain no identifiers.** Audit counts carry no IP hashes: an unkeyed hash
  of an IPv4 address is reversible, and the KEK must never be reused as a MAC key. Logs contain at
  most a 12-hex-character SHA-256 prefix of the mailbox id.
- **D-K4 Background work after the response** uses Vercel's request-context `waitUntil` when it is
  present, otherwise it is awaited with 3–5 s timeouts. No timers keep the function alive.
- **D-K5 Fail closed on config.** A bad or missing `TOKEN_KEKS`, active kid, issuer, subject,
  audience or origin, or any `VERCEL_TOKEN*` in the environment, means every request gets 503. The
  alert channel is optional (warn only) so that refreshes never fail because of alert config.
  A missing or malformed `KEYS_ALERT_TOKEN` / `GITHUB_ALERT_REPO` (values are trimmed) disables
  alerting only: one startup `{ev:"warning",code:"alert_unconfigured"}` log per instance and
  `alert_unconfigured: 1` in every `/api/keys-audit` report. Report windows are clamped to
  edf-app's 86,400 s limit, and `window_clamped: 1` marks a clamped report.
- **D-K6 Unbundled deployment.** Vercel compiles `api/unwrap.ts` and traces `src/`, so relative
  imports use `.js` extensions (Node ESM).
- **D-K7 Static output is `public/` only.** With `framework: null` and no build command, Vercel
  would otherwise publish the project root (`src/`, `test/`, `tsconfig.json`) as static files,
  exposing the key service's logic and D-K1 alert thresholds. `outputDirectory: "public"`
  (robots.txt only) serves nothing else, as for edf-view (D-V5).

## Sanitizer (`packages/sanitize`)

- **D-S1 Output document.** Output is always `<!DOCTYPE html>` + the whole document, which renders
  in standards mode like Gmail.
- **D-S2 URL attributes are captured before DOMPurify's URI check.** This applies to `src`, `href`
  and `background`. They are always removed and re-added only from our own rewrite.
  - Relative, protocol-relative and fragment URLs are dropped.
  - Rewriter output must be an absolute http(s) URL; `cid` results may also be a data:image of up
    to 2 MB.
  - `data:image` from email content must be base64, ≤ 256 KB, and its decoded bytes must really be
    PNG, JPEG, GIF or WebP. Browsers sniff, so a declared type proves nothing. `DATA_IMAGE_RE` is
    written to be linear (no overlapping adjacent quantifiers, a flat parameter class), because
    values reach 32 MB in the analysis profile.
  - `images` counts only proxied `http(s)`/`cid:` images that are in the output, including CSS
    `url()`.
  - **A token is minted only for an image that is emitted.** The viewer's image rewriter mints a
    token per call, so it is called only for images that reach the output:
    - `<style>` urls are rewritten in `afterSanitizeElements`, after DOMPurify keeps the element.
      A forbidden `<template>` is emptied in `uponSanitizeElement`, because DOMPurify still walks
      its content.
    - In `css.ts`, a url is rewritten only after its declaration is validated and the paranoid
      scan has passed. The scan covers every child that could still fit the cap, and for style
      attributes also DOMPurify's `SAFE_FOR_XML` probes.
    - Urls with no side effect (`data:`, `cid:`) are rewritten first. An http(s) url is rewritten
      only if the declaration still fits the cap with a reserve for each such url; otherwise the
      declaration is dropped, even if the real urls would have fit. Every such url after the first
      also reserves at least the size of the blank GIF it may become (below).
    - The reserve is `ViewerRewriters.imageMaxLength`: the longest URL `image()` returns, by default
      and at most `REWRITTEN_URL_MAX_CHARS` (8192). Sizes are counted as css-tree writes them, with
      escapes. apps/web declares the longest form of its `${VIEW_ORIGIN}/img/` prefix (the raw
      string, or its href as written in a CSS `url()`, counting one extra byte for each `\` `"` `'`
      `(` `)` or space, which css-tree escapes, and each `<`, which gets a space) plus
      `IMAGE_TOKEN_MAX_LENGTH`, so a token that is minted is never refused for its length.
    - A result longer than `imageMaxLength` is dropped; in CSS, a result longer than its reserve
      once escaped counts as refused. If the rewriter refuses an http(s) url after accepting
      another in the same declaration, the refused one becomes a 1×1 transparent GIF `data:` URL
      instead of dropping the declaration (and the minted url with it). So a token is wasted only
      if the rewriter returns more than it declared.
    - **Known tradeoff, kept on purpose:** the pre-scan runs on the text before any url is
      resolved, so a forbidden token inside a url declaration drops the whole sheet or style value,
      even when that declaration would later be dropped (refused, over the 60-token cap, no room).
      Deciding it from the emitted output would mean calling the rewriter, and so minting, for
      output that is then thrown away. There is no safety impact: the final scan of the output is
      unchanged.
  - Extra attributes stripped: `cite`, `longdesc`, `download`, `target`, `rel`, `nonce`,
    `integrity`, `popover*`, `command*`.
- **D-S3 Performance patch.** jsdom eagerly parses every `style` attribute into `el.style`, which
  costs about 80% of the time. That sync is skipped only for documents of the sanitizer's own
  jsdom window: we never read `el.style`, and attribute values are untouched.
  - jsdom is pinned to 30.1.1. The patch is best effort: if the internals move, it is slower but
    still correct.
  - A test proves other jsdom windows are unaffected.
  - Result: about 50 ms for a 100 KB newsletter (was about 440 ms).
- **D-S4 CSS rewriting** is a fail-closed allowlist on the css-tree AST.
  - Allowlisted at-rules only. Everything else is dropped: `Raw`, comments, CDO/CDC, custom
    properties, dangerous properties and functions (names escape-decoded and ASCII-lowercased),
    and preludes containing `url`.
  - `<` before `/ ! ? word` gets a following space, so no `</style` or markup probe can appear.
  - A final paranoid scan drops the whole CSS if a forbidden token survives.
  - Caps: 64 KB per style attribute; `<style>` budget per document of 64 KB for the viewer and
    1 MB for analysis. The analysis profile is isolated and needs fidelity, and §11.5's cap is a
    viewer rule.
  - Input caps: 10 MB for the viewer and 32 MB for analysis. Analysis HTML carries inlined images;
    over the cap, `SanitizeInputError` is thrown.
- **D-S5 Analysis profile.**
  - Keeps original http(s), `cid:` and data:image sources and http(s)/mailto links, because the
    renderer intercepts every request.
  - Keeps `meta` only for viewport and color-scheme, with a restricted content charset.
  - Keeps only numeric `data-o` values. The ingest stamper must overwrite any `data-o` present in
    the raw email.
  - Uses the same CSS rules as the viewer, so `@import` and `@font-face` are dropped.

## Fetcher (`packages/fetch`)

- **D-F1 Connection rules.**
  - Addresses are resolved and validated inside the connect `lookup`, so the check and the connect
    use the same answer (rebinding-proof). One disallowed address fails the whole host.
  - Deny list: ipaddr.js `unicast` only, the §11.7 list, documentation and relay ranges, and IPv6
    outside `2000::/3`.
  - Hostnames: single-label names, special-use suffixes, metadata names and anything not under an
    ICANN public suffix are denied.
  - Ports: `http` only on 80 and `https` only on 443. This is stricter than "80/443".
- **D-F2 Response rules.**
  - Only status 200 is accepted.
  - Content-type prefix allowlist.
  - Caps on both decoded bytes and raw bytes. Stacked or unknown content encodings are refused.
  - A 3 s header deadline inside a 5 s total.
  - The served `Content-Type` comes from the sniffed magic bytes.
  - GIF dimensions include the first frame's extent, as browsers do.
  - Test hooks (resolver, trusted test hosts, extra ports) are not exported, and they only work
    under vitest or `NODE_ENV=test`.

## edf-view (`apps/view`)

- **D-V1 View-token gate.** The gate has no clock skew: tokens with an `exp` in the past or more
  than 300 s ahead are dropped. **edf-app should mint `exp = now + 240`**, so small clock
  differences never produce false 400s.
- **D-V2 Upstream mapping.** 400→400, 401/403→403, 404/410→404, 429→429, other→502, timeout→504.
  Error pages use the same five headers as the viewer. `height` is validated (0–1e6) but not used:
  the frame cannot report it, so the app sizes the iframe itself.
- **D-V3 Image caching and budget.**
  - Deterministic failures (blocked, not an image, too many pixels, too large for the token)
    return the placeholder with the 1-day cache.
  - Transient failures get `s-maxage=300`.
  - Bad or expired tokens and budget-limited results get `no-store`.
  - The per-email budget (40 MB) is kept in memory per instance, bounded by the tokens' 14-day
    lifetime and 10k entries.
  - Per image: a token's `mb` is at most `IMAGE_TOKEN_MAX_BYTES` = 5 MB (2 MB until 2026-09-30,
    which left one-picture mailers' 3–5 MB heroes grey) on both sides, and edf-view's per-response
    backstop is the same 5 MB (was 4 MB, under Vercel's 4.5 MB limit for functions that don't
    stream; edf-view's functions stream). A raised ceiling ships edf-view first: an older edf-view
    refuses a larger `mb` as a bad token. FREE-TIER.md §8.4 item 3 has the numbers and the week-1
    check.
  - edf-app mints the budget id per email and expiry day (`<emailId>_<exp base36>`). edf-view
    keys its ledger on the signed (u, e, b) tuple, not `b` alone, so tokens minted before that
    change (which carry a shared `b` and live up to 48 h) stay separate.
- **D-V4 Trackers.** edf-app makes the tracker, per-recipient and pixel decision (via
  `@edf/core/policy`) and mints tokens only for allowed URLs. edf-view cannot depend on
  `@edf/core`, so it adds a small built-in denylist of tracker-only hosts, answered with a 1×1 GIF,
  on top of the Ed25519 signature.
- **D-V5 Bundle layout.**
  - `api/v.js` does not bundle the image fetcher (20 KB, faster cold start); `api/img.js` bundles
    `@edf/fetch` with undici, ipaddr.js and tldts (about 1.3 MB).
  - `outputDirectory: "public"` (robots.txt only) keeps Vercel from serving the project root
    (sources) as static files.
  - Vercel discovers `api/` functions from repository files, so **commit `api/*.js`**. CI should
    run `pnpm --filter @edf/view build && git diff --exit-code apps/view/api`.
- **D-V6 Public paths only.** The functions accept only `/v/<token>/<emailId>` and `/img/<token>`,
  where every segment is plain token characters (`[A-Za-z0-9_.-]`, and `[A-Za-z0-9_-]` for the
  email id). Vercel passes the original path through a `vercel.json` rewrite, so direct `/api/v`
  and `/api/img` calls, percent-encoded bytes, empty segments and trailing slashes get 404 / 403
  without forwarding or fetching. The `?token=` query form is not accepted.
  - Dot segments (including `%2e%2e`) are collapsed by URL parsing before the code runs, so they
    can only arrive as the canonical path. Stopping them at the edge is the WAF's job
    (FREE-TIER.md §8.4: a rate-limit rule with no path condition, plus "Deny /api/*").
  - On each new preview deploy open `/v/test/test`: a 404 means the function is not seeing the
    original `/v/...` path. A preview can't show an email: without viewer settings every request
    gets 503; with them `/v/test/test` gets 400 and a real `/v` link gets 403, since the app accepts
    only the production viewer's OIDC subject. So finish on production:
    `/v/test/test` must answer 400, and a real `/v` link must render (docs/SETUP.md §2 step 9).

## Machine-to-machine contracts (orchestrator)

- **D-M1 Stats and audit payloads.** `POST /api/view-stats` (edf-view) and `POST /api/keys-audit`
  (edf-keys) carry `Authorization: Bearer <plain function token>` and a body that is exactly
  `{"v":1,"windowStart":<unix s>,"windowEnd":<unix s>,"counts":{"<code>":<int>}}`.
  - Codes match `^[a-z0-9_]{1,40}$`.
  - Values are capped at 10,000,000; the excess carries over to the next report, so totals are
    never lost.
  - A report is sent only when there is something to report. edf-keys sends at most once a
    minute. edf-view sends once a minute, or sooner once 4 MB of served image bytes are pending
    (never twice within 10 s), plus one delayed report 12 s after image bytes that nothing else
    reports (apps/view `stats.ts`; edf-app meters those bytes as Fast Origin Transfer). A failed
    POST keeps its counts for the next attempt.
  - Neither service sends a window longer than 86,400 s (edf-app's limit). After long failures
    the window start rolls forward, and the carried-over counts are reported in the capped window
    (edf-keys adds `window_clamped: 1`, D-K5).
  - edf-view codes: `view_requests`, `view_forwarded`, `view_rejected_expiry`,
    `view_rejected_format`, `view_upstream_error`, `img_requests`, `img_ok`, `img_bad_signature`,
    `img_blocked_tracker`, `img_budget_exceeded`, `img_too_large`, `img_upstream_error`,
    `img_bytes_served`, `img_card_bytes_served` (a subset of `img_bytes_served`).
  - edf-keys codes: `generate_ok`, `unwrap_ok`, `rewrapped`, and `refused_{oidc,body,version,unwrap,
method,path,too_large,media_type,rate_limited,misconfigured}`, plus the flags `alert_unconfigured`
    and `window_clamped` (value 1, D-K5).
- **D-M2 Local development OIDC.** One shared dev issuer from `gen-keys --dev`, with env
  `DEV_OIDC_ISSUER`, `DEV_OIDC_AUD`, `DEV_OIDC_JWKS` and `DEV_OIDC_PRIVATE_JWK`.
  - Defaults are the `@edf/crypto` constants `DEV_OIDC_ISSUER` and `DEV_OIDC_AUDIENCE`.
  - Subjects: `DEV_APP_SUB` = `dev:edf-app`, `DEV_VIEW_SUB` = `dev:edf-view`,
    `DEV_KEYS_SUB` = `dev:edf-keys`.
  - The edf-keys dev server verifies `DEV_APP_SUB` tokens and signs its audit calls as
    `DEV_KEYS_SUB`. The edf-view dev server signs as `DEV_VIEW_SUB`. All dev tokens use
    `aud = DEV_OIDC_AUD`.
