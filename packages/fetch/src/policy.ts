/**
 * Target validation for the SSRF-safe fetcher (DESIGN.md §11.7).
 *
 * Addresses: after `ipaddr.process()` (which unwraps IPv4-mapped and IPv4-compatible IPv6),
 * anything whose ipaddr.js range is not `unicast` is denied, plus an explicit CIDR list (the
 * §11.7 list and the documentation/benchmark/relay ranges), plus IPv6 outside 2000::/3.
 * Hostnames: single-label names, special-use suffixes (localhost, .local, .internal, …),
 * cloud metadata names and anything that isn't under an ICANN public suffix are denied.
 */
import ipaddr from "ipaddr.js";
import { parse as parseDomain } from "tldts";
import { testOverrides } from "./testing";

export type TargetError =
  "bad_url" | "bad_scheme" | "bad_port" | "blocked_host" | "blocked_address";

const V4_DENY = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((c) => ipaddr.IPv4.parseCIDR(c));

const V6_DENY = [
  "::/128",
  "::1/128",
  "::/96", // IPv4-compatible (deprecated)
  "::ffff:0:0/96", // IPv4-mapped
  "::ffff:0:0:0/96", // SIIT
  "64:ff9b::/96", // NAT64
  "64:ff9b:1::/48", // local-use NAT64
  "100::/64", // discard
  "2001::/23", // IETF protocol assignments (Teredo, benchmarking, ORCHID, …)
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4
  "3fff::/20", // documentation
  "5f00::/16", // SRv6 SIDs
  "fc00::/7", // unique local
  "fe80::/10", // link local
  "fec0::/10", // site local (deprecated)
  "ff00::/8", // multicast
].map((c) => ipaddr.IPv6.parseCIDR(c));

const V6_GLOBAL_UNICAST = ipaddr.IPv6.parseCIDR("2000::/3");

/** Special-use and internal suffixes (RFC 6761/6762/8375/9476 and common internal zones). */
const DENY_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "private",
  "corp",
  "home",
  "lan",
  "home.arpa",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "alt",
];
/** Cloud metadata and other well-known internal names. */
const DENY_EXACT = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "kubernetes.default",
  "kubernetes.default.svc",
]);

const LABEL_RE = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** True if `ip` (v4 or v6, no zone id) may be connected to. */
export function isAllowedAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.includes("%")) return false;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return false;
  }
  if (addr.range() !== "unicast") return false;
  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    return !V4_DENY.some((cidr) => v4.match(cidr));
  }
  const v6 = addr as ipaddr.IPv6;
  if (!v6.match(V6_GLOBAL_UNICAST)) return false;
  return !V6_DENY.some((cidr) => v6.match(cidr));
}

/** Strip IPv6 brackets; returns the bare literal or null if `host` is not an IP literal. */
export function ipLiteral(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return ipaddr.isValid(bare) && (bare.includes(":") || /^[0-9.]+$/.test(bare)) ? bare : null;
}

/** True if a DNS hostname may be resolved and fetched. */
export function isAllowedHostname(hostname: string): boolean {
  if (typeof hostname !== "string") return false;
  let h = hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253 || !h.includes(".")) return false;
  if (!h.split(".").every((l) => LABEL_RE.test(l))) return false;
  if (DENY_EXACT.has(h)) return false;
  if (DENY_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return false;
  const p = parseDomain(h);
  if (p.isIp || p.isIcann !== true || !p.domain || !p.publicSuffix || h === p.publicSuffix)
    return false;
  return true;
}

export type ValidTarget =
  { ok: true; url: URL; hostKey: string } | { ok: false; error: TargetError };

/** Validate scheme, credentials, port and host (IP literals are checked here; names at connect). */
export function validateTarget(input: string): ValidTarget {
  if (typeof input !== "string" || input.length === 0 || input.length > 8192)
    return { ok: false, error: "bad_url" };
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, error: "bad_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "bad_scheme" };
  if (u.username !== "" || u.password !== "") return { ok: false, error: "bad_url" };
  const port = u.port === "" ? (u.protocol === "http:" ? 80 : 443) : Number(u.port);
  const defaultPort =
    (u.protocol === "http:" && port === 80) || (u.protocol === "https:" && port === 443);
  const ov = testOverrides();
  if (!defaultPort && !(ov?.extraPorts?.includes(port) ?? false))
    return { ok: false, error: "bad_port" };
  const host = u.hostname;
  const lit = ipLiteral(host);
  if (lit !== null) {
    if (!isAllowedAddress(lit)) return { ok: false, error: "blocked_address" };
  } else if (
    !(ov?.trustedHosts?.has(host.replace(/\.$/, "")) ?? false) &&
    !isAllowedHostname(host)
  ) {
    return { ok: false, error: "blocked_host" };
  }
  u.hash = "";
  return { ok: true, url: u, hostKey: host.replace(/\.$/, "").toLowerCase() };
}
