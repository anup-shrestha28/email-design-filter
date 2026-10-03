# Decisions: `@edf/gmail` and `@edf/budget`

Where the spec was ambiguous, we chose the reading that can't lose mail or overspend. Each entry
says what we chose and why. Section references are to `docs/FREE-TIER.md` (FT) and
`docs/DESIGN.md` (D).

## @edf/gmail

**G1. Cursor rule when paging stops early (FT §4.2 step 5).**

- `newCursor` is the `id` of the last History record processed, never the top-level `historyId`.
- If a page is empty but has a `nextPageToken`, we keep paging past `maxPages` until at least one
  record has been processed. Only the deadline stops us. Otherwise an empty first page could pin
  the cursor forever.
- If records arrive out of order and paging must stop early, `pollHistory` throws
  `GmailError("bad_response", reason "history_out_of_order")` and doesn't guess. Gmail documents
  chronological order, and a complete listing is accepted in any order.

**G2. Cursor when paging finishes across several pages.** We use the _first_ page's `historyId`,
not the last one's.

- A page-token listing may be pinned to a snapshot. If so, records created while we were paging
  would be missing from it, but the last page's `historyId` would already count them.
- Using the first page's id only means re-reading a few records next time. Every apply step is
  idempotent: the ledger PK, `gmail_history_id < h`, and hard deletes.
- A single-page poll uses that page's `historyId`, exactly as the spec says.

**G3. Formats and size caps (D §5.2).**

- Automated mail uses `format=raw` (`RAW_FIELDS`) so postal-mime can parse it.
- If the response exceeds its cap (`DEFAULT_RAW_MAX_BYTES` = 4 MiB of HTTP body, about 3 MB of
  RFC 822), the caller falls back to `format=full` (`FULL_FIELDS`) plus `parsedFromGmailPayload`.
- `messagesGet({maxBytes})` caps the _HTTP body_. `attachmentsGet({maxBytes})` caps the _decoded_
  bytes, and the body cap is derived from it.
- Both caps are enforced while streaming, so an oversized response is never fully read.

**G4. Backfill slice boundaries.**

- The query writes `after:` one second early, so a message exactly on a boundary can't fall
  between two slices whatever Gmail's inclusivity is. Duplicates die on the ledger PK.
- The newest slice has no `before:`, so mail arriving during the backfill is listed too.

**G5. Gap window after a history 404.** `max(7 d, gap)`, capped at `backfill_window_days`.

- A gap longer than 7 days gets one extra day of margin, because the cursor can lag
  `last_synced_at` after an incomplete poll.
- `lastSyncedAt = null` means the whole window.

**G6. Ledger retries (FT §4.6).**

- `drainBackoff(n)` gives 1 m, 5 m, 30 m, 2 h, 6 h.
- `ledgerFailureOutcome(attempts)` marks a row `failed` only when `attempts > MAX_ATTEMPTS` (5).
  So all five listed backoffs are used: the 6 h wait would otherwise be dead code.
- Failed rows are re-driven daily for 7 days anyway.

**G7. Error kinds.**

- **Added `bad_request`** for other 400s, which are our bugs and never retried.
- **Project-level refusals map to `daily_limit`** (global pause and alert), not per-mailbox
  `policy`. These are 403 `accessNotConfigured`, `SERVICE_DISABLED`, `projectNotLinked` and the
  like, and they affect every mailbox.
- **Other 403s map to `policy`.**
- **`unauthorized` is retriable.** A persistent 401 surfaces as `invalid_grant` on the next
  forced refresh.

**G8. Global incidents.** `invalid_client`, `deleted_client` **and `unauthorized_client`** are
global incidents (D §4.4 lists all three; FT §4.8 names two). This never marks mailboxes
`needs_reauth` wrongly.

**G9. `invalid_grant` transition (D §4.4).** The UPDATE requires `status='active'` **and**
`refresh_token_enc` still equal to the ciphertext that failed.

- A reconnect during the refresh is therefore never clobbered: the provider re-reads and returns
  the new token.
- The transition nulls `refresh_token_enc`, `access_token_enc`, `access_token_expires_at`,
  `dek_wrapped` and the lease.
- `admin_policy_enforced` is thrown as a non-retriable `OAuthError`. Setting `paused` is left to
  the caller, because the spec gives no state for it at refresh time.

**G10. Storing a refreshed token.**

- The store requires the same refresh ciphertext, and the lease must be ours or free (expired).
- A token Google _rotates_ is stored even if the lease was lost. Otherwise the grant could be lost.
- A cached access token that won't decrypt (for example a retired `ACCESS_TOKEN_KEYS` kid) is
  treated as missing and refreshed.
- The per-invocation DEK cache is **opt-in** (`cacheDeks`). It holds one user at a time, clears
  when a different user is seen, and `dispose()` zeroes it. Keys are zeroed after every use.

**G11. 401 retry contract.**

- `GetAccessToken(opts?: { rejectedToken })`: when Gmail rejects token T, the provider must return
  a different token.
- It refreshes under the lease unless another worker already stored a newer one.
- This avoids a second refresh when two requests hit 401 at once.

**G12. History merging.**

- Label deltas are net per message: the last operation per label wins, and the add and remove
  sets are disjoint. `historyId` is the last record touching the message and is used as `h`.
- **SPAM added** is just a label delta that sets `in_spam`.
- **SPAM removed** (and not re-added) sets `refetch`.
- **A message added as SPAM and un-spammed in the same poll** becomes `insert`.
- **DRAFT, SENT and CHAT** new messages are reported as `skip` with a reason. The pipeline may
  insert `skipped` rows (keep them for spam) or drop them.

**G13. Payload adapter.**

- Body parts are text/html or text/plain parts that aren't `attachment` and have no filename.
- Inside one `multipart/alternative`, only the last part of each kind is kept. Elsewhere, parts
  are concatenated, which handles Apple Mail's split HTML.
- Inline (`cid:`) images are **omitted** from `inline`, but listed in `attachments` as metadata.
- Header values are unfolded and decoded (RFC 2047).
- From/To/Cc/Reply-To are parsed from the **undecoded** value, and only display names are decoded
  afterwards. An encoded-word can carry `,` `<` `@`, so decoding first would let it split the list
  or spoof the address. Entries without a usable `@` are dropped, as on the postal-mime path.
  A quoted local part keeps its quotes here (`"x"@a.example`), while core's raw-MIME parser drops
  them when the content is a plain dot-atom (packages/core/DECISIONS.md, Parsing). Aligning the
  two is an optional follow-up.
- `snippet` HTML entities are decoded to plain text. The UI must still escape it.

**G14. Revoke.** A 400 `invalid_token` counts as success: the grant is gone either way.

**G15. Transport.**

- Global `fetch` with a FIFO semaphore (≤ 4 per client), a 30 s timeout that includes the body,
  and `redirect: "error"`, so a bearer token is never forwarded to another host.
- No undici `Agent({allowH2})`: it was optional, and mixing the npm undici dispatcher with Node's
  bundled fetch isn't guaranteed to work.

**G16. ID token.**

- google-auth-library checks the signature, `iss`, `exp` and `aud`.
- We also require `email_verified` and compare the nonce in constant time.
- The library's error messages embed the token and payload (including the address), so they are
  swallowed and replaced by `ConnectError(reason)`.

**G17. uint64.**

- History ids are validated as decimal strings and compared as BigInt.
- JSON numbers for `historyId` are rejected (`bad_response`), because precision is already lost
  once `JSON.parse` turns them into Numbers.

## @edf/budget

These are @edf/budget's earlier decisions. Newer ones, and any that replace an entry below, are in
`packages/budget/DECISIONS.md`.

**B1. Anthropic "actual" spend.**

- It is `max(settled month-to-date usage × factor, llm_budget_global.reserved_usd)`, because
  reservations include in-flight calls.
- A projection or pace overrun can only trigger the soft action (`autoAiOff`). `aiOff` needs
  actual spend at the app cap (0.9 × G).

**B2. Fast Origin Transfer.**

- FT §8.3 gives FOT its own actions at the soft threshold and the self-cap (images click-to-load),
  so it does **not** raise global L1/L2.
- It does raise **L3 at 70% of the hard limit** (7 GB), as FT §8.2 says explicitly.

**B3. Sandbox.**

- Fill renders stop at the soft threshold _or_ at 55% of the hard limit (FT §5.3), whichever
  comes first.
- **Sandbox memory** gets a 70% self-cap (294 GB-h) that the docs don't list. It uses the same
  actions and is never global.

**B4. Hysteresis.**

- To step down from level N, _every_ resource must be below 80% of its level-N threshold, not
  only the one that triggered it.
- For L1, projections and pace budgets must also be below 80%.
- The 24 h clock restarts after each one-level step. If still clear, it restarts at the moment of
  the step.

**B5. Early-month pace (before day 7).** "Cap ÷ 30 × 1.5 per day" is read as: L1 (or soft) when
month-to-date ≥ days elapsed (today included) × self-cap ÷ 30 × 1.5.

**B6. Neon storage** is measured in decimal MB (`pg_database_size / 1e6`). That reaches each
threshold slightly earlier than MiB would.

**B7. Metering.**

- **CPU** is sampled process-wide, as the delta since the previous sample. This avoids
  double-counting concurrent Fluid requests, and it counts framework and cold-start CPU between
  wrappers. The first sample includes CPU since process start.
- **GB-h** is summed per invocation. This over-counts under concurrency, which partly offsets
  idle instance time. The calibration factor absorbs the rest.
- **Amounts** are rounded _up_ to 6 decimals.
- **A failed flush** keeps its amounts buffered.
- **Rows** are written in sorted order (no deadlocks) and split into ≤ 1e9 chunks for
  `add_usage`.
- **Byte resources** are stored in MB.

**B8. LLM caps (FT §6.5).**

- Only friends' caps scale with G/5, as the spec says. The owner's $3/month and $0.50/day don't
  scale.
- While the owner is the only active user, the owner's month cap is the global cap and the day
  cap stays $0.50.
- The friends' equal split: **replaced**, see "Opus 5 friends' split" in
  `packages/budget/DECISIONS.md`. Each friend's month cap is now at most
  `(0.9 × G − max(owner's month reservations, $1.60 owner hold)) ÷ activeFriends`, with the
  owner's figure from `llm_owner_month_reserved` (migration 0009). The share no longer grows back
  as friends reserve.
- Caps round down and prices round up (numeric(10,4)).

**B9. Settlement pricing.** Cache writes without a per-TTL breakdown are priced at the 1-hour
rate (the higher one), unless the caller passes the TTL it requested.

**B10. Neon billing period.** Periods start on the day of month of `app_setting.neon.period_start`,
clamped for short months. If it's null, the calendar month is used.
