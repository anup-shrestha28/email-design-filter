# @edf/fetch — implementation decisions

Where the spec (DESIGN.md §11.7, FREE-TIER.md §8.4, §9.2) was silent, these are the choices made
and why.

## Timeouts

- The overall deadline (≤ 5 s) and the header budget (≤ 3 s) cover DNS, TCP connect and TLS, not
  just the time after the request is written. undici only acts on an abort once a request is on
  a socket, so `fetchOnce` settles the `request()` promise itself when the signal aborts
  (`settleOnAbort`). A connection attempt that is still running is left to the Agent's 5 s
  connect timeout and any late response is discarded. That attempt keeps its per-host slot until
  it ends, so the ≤ 4 per host limit counts abandoned attempts too (also across the http and
  https origins of one host); later calls wait for a slot within their own deadline.

## DNS

- Names are resolved with a per-call c-ares resolver (`dns.promises.Resolver`, A + AAAA, IPv4
  addresses first), not `dns.lookup()`. getaddrinfo runs on the libuv threadpool (4 threads,
  shared with zlib, fs and crypto) and cannot be cancelled, so a hostile nameserver could hold
  threads after the fetch gave up. Each resolution is cancelled after 2.5 s.
- Production egress (Vercel functions) is IPv4-only, so the A lookup is always awaited and AAAA
  only adds addresses to it. An early AAAA answer never cuts A short. Once A has returned
  addresses, AAAA gets 50 ms more (RFC 8305's resolution delay, which applies only when A comes
  first), so a nameserver that drops AAAA queries does not cost the whole budget. A late AAAA
  answer is dropped, which is harmless because IPv4 is used anyway. A name with only AAAA records
  (A answered with no records) still resolves to its IPv6 addresses, as getaddrinfo would. But if
  the A query never gets an answer (dropped, or later than the 2.5 s bound) while AAAA did, the
  lookup fails with `EAI_AGAIN` (`dns`) rather than returning IPv6 only, which would just fail to
  connect (`network`) on IPv4-only egress. c-ares sends each query up to twice (`timeout: 1000`,
  `tries: 2`) and discards a reply to the first attempt that arrives after the retry was sent, so
  an A answer counts only if the first attempt is answered within 1 s or the retry by the 2.5 s
  mark. If A fails outright (SERVFAIL, REFUSED), the lookup still waits for AAAA, up to 2.5 s,
  before reporting `dns`: slower, but the answer is the same. Every returned address is validated.
- A nameserver that never answers fails with `EAI_AGAIN`, which the fetch reports as `dns`, as
  getaddrinfo did. The 2.5 s bound is below the 3 s header budget so that this happens while the
  call still has time. If the call's own deadline (or header budget) runs out first, the fetch
  reports `timeout`.
- Consequence: `/etc/hosts`, nsswitch and resolv.conf search domains are not used, only the
  nameservers in `/etc/resolv.conf`, and addresses come back IPv4 first rather than in
  getaddrinfo's order. That is intended for a fetcher of public hosts (internal names are denied
  anyway). Tests point the resolver at a local fake nameserver via `dnsServers`.
- Hostname length (≤ 253) and label rules are checked before any query is sent.

## SVG responses are flagged, still refused (2026-09-30)

- `fetchImage` keeps refusing SVG (`not_image`), but now says so: `svg: true` when the type is
  `image/svg+xml` or the body starts with an `<svg` root (after an XML prolog, comments or a
  doctype). Gmail doesn't show SVG either, so the render pre-fetch logs it as `reason: "svg"` and
  the analysis reports "an SVG Gmail won't show" instead of a broken image. The served bytes and
  the proxy's behaviour are unchanged.
