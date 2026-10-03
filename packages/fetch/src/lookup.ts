/**
 * The DNS pin (DESIGN.md §11.7): a `lookup` for net/tls.connect that resolves once, validates
 * EVERY returned address and hands exactly those addresses to the socket, so there is no second
 * resolution a rebinding attacker could win. One bad address fails the whole host.
 *
 * Names are resolved with c-ares (A + AAAA) on the event loop, not `dns.lookup()`: getaddrinfo
 * runs on the small libuv threadpool (shared with zlib, fs and crypto) and cannot be cancelled,
 * so a nameserver that never answers would hold a thread long after the fetch gave up. Here every
 * resolution is cancelled after LOOKUP_TIMEOUT_MS.
 */
import { promises as dns, type LookupAddress, type LookupOptions } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { ipLiteral, isAllowedAddress, isAllowedHostname } from "./policy";
import { testOverrides } from "./testing";

/** Error codes our fetcher recognises when they surface from undici. */
export const BLOCKED_ADDRESS_CODE = "EDF_BLOCKED_ADDRESS";
export const BLOCKED_HOST_CODE = "EDF_BLOCKED_HOST";

/**
 * Hard bound on one resolution. Kept below the header budget (3 s) so a nameserver that never
 * answers fails the fetch as "dns" (like getaddrinfo's EAI_AGAIN) while the call still has time;
 * if the call's own deadline runs out first, the fetch reports "timeout" instead.
 */
const LOOKUP_TIMEOUT_MS = 2500;
/** Once A has answered, how long to wait for AAAA (RFC 8305 "Resolution Delay"). */
const RESOLUTION_DELAY_MS = 50;

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function errorCode(r: PromiseSettledResult<unknown>): string {
  return r.status === "rejected" ? String((r.reason as { code?: unknown })?.code ?? "") : "";
}

/**
 * A and AAAA via a per-call c-ares resolver that is cancelled at LOOKUP_TIMEOUT_MS. Production
 * egress (Vercel functions) is IPv4-only, so A is always awaited and AAAA only adds to it: once A
 * returns addresses, AAAA gets RESOLUTION_DELAY_MS more (a nameserver that answers A but drops
 * AAAA must not cost the whole budget); an early AAAA answer never cuts A short. IPv6-only results
 * are returned only when A answered with no records. Only returned addresses are used, IPv4 first.
 */
async function resolveName(hostname: string): Promise<LookupAddress[]> {
  const resolver = new dns.Resolver({ timeout: 1000, tries: 2 });
  const servers = testOverrides()?.dnsServers;
  if (servers !== undefined) resolver.setServers(servers);
  const timer = setTimeout(() => resolver.cancel(), LOOKUP_TIMEOUT_MS);
  timer.unref?.();
  let grace: NodeJS.Timeout | undefined;
  try {
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname).then((list) => {
        if (list.length > 0) {
          grace = setTimeout(() => resolver.cancel(), RESOLUTION_DELAY_MS);
          grace.unref?.();
        }
        return list;
      }),
      resolver.resolve6(hostname),
    ]);
    const codes = [errorCode(v4), errorCode(v6)];
    const timedOut = codes.some((c) => c === dns.CANCELLED || c === dns.TIMEOUT);
    // IPv6 alone is used only when A definitely has no records; if A never came back, an
    // IPv6-only answer would just fail to connect on IPv4-only egress, so report the DNS failure.
    const noA = codes[0] === dns.NODATA || codes[0] === dns.NOTFOUND;
    if (v4.status === "rejected" && !noA)
      throw codedError(timedOut ? "EAI_AGAIN" : "ENOTFOUND", "no A answer");
    const addrs: LookupAddress[] = [
      ...(v4.status === "fulfilled" ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === "fulfilled" ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
    if (addrs.length > 0) return addrs;
    if (timedOut) throw codedError("EAI_AGAIN", "dns timeout");
    throw codedError("ENOTFOUND", "no addresses");
  } finally {
    clearTimeout(timer);
    clearTimeout(grace);
  }
}

async function resolveAll(hostname: string): Promise<LookupAddress[]> {
  const ov = testOverrides();
  const trusted = ov?.trustedHosts?.get(hostname.replace(/\.$/, ""));
  if (trusted !== undefined) return [{ address: trusted, family: isIP(trusted) === 6 ? 6 : 4 }];

  const lit = ipLiteral(hostname);
  let addrs: LookupAddress[];
  if (lit !== null) {
    addrs = [{ address: lit, family: isIP(lit) === 6 ? 6 : 4 }];
  } else {
    if (!isAllowedHostname(hostname)) throw codedError(BLOCKED_HOST_CODE, "blocked host");
    addrs = ov?.resolve ? await ov.resolve(hostname) : await resolveName(hostname);
  }
  if (!Array.isArray(addrs) || addrs.length === 0) throw codedError("ENOTFOUND", "no addresses");
  for (const a of addrs) {
    if (!isAllowedAddress(a.address)) throw codedError(BLOCKED_ADDRESS_CODE, "blocked address");
  }
  return addrs.map((a) => ({ address: a.address, family: isIP(a.address) === 6 ? 6 : 4 }));
}

/** `lookup` option for undici's connector (supports both `all: true` and single-address calls). */
export const safeLookup: LookupFunction = (hostname: string, options: LookupOptions, callback) => {
  resolveAll(hostname).then(
    (addrs) => {
      const wanted =
        options.family === 4 || options.family === 6
          ? addrs.filter((a) => a.family === options.family)
          : addrs;
      if (wanted.length === 0) {
        callback(codedError("ENOTFOUND", "no address of requested family"), "", 0);
        return;
      }
      if (options.all === true) callback(null, wanted);
      else
        callback(null, (wanted[0] as LookupAddress).address, (wanted[0] as LookupAddress).family);
    },
    (err: NodeJS.ErrnoException) => callback(err, "", 0),
  );
};
