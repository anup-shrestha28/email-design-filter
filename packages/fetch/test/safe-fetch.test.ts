import { createSocket, type Socket as UdpSocket } from "node:dgram";
import type { LookupAddress } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { promisify } from "node:util";
import { gzip, gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SAFE_FETCH_USER_AGENT,
  fetchImage,
  isAllowedAddress,
  isAllowedHostname,
  safeFetch,
  validateTarget,
} from "../src/index";
import { safeLookup } from "../src/lookup";
import { setTestOverrides } from "../src/testing";
import { SVG, png } from "./images";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const routes = new Map<string, Handler>();
const seenHeaders: IncomingMessage["headers"][] = [];
let server: Server;
let port = 0;
let active = 0;
let maxActive = 0;

const BASE = () => `http://img.test:${port}`;
const IMG = { accept: ["image/"], maxBytes: 1024 * 1024, timeoutMs: 2000 };

beforeAll(async () => {
  server = createServer((req, res) => {
    seenHeaders.push(req.headers);
    active++;
    maxActive = Math.max(maxActive, active);
    res.on("close", () => active--);
    const h = routes.get((req.url ?? "/").split("?")[0] ?? "/");
    if (h) h(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function trusted(extra: Parameters<typeof setTestOverrides>[0] = {}) {
  setTestOverrides({
    trustedHosts: new Map([["img.test", "127.0.0.1"]]),
    extraPorts: [port],
    ...extra,
  });
}

afterEach(() => {
  setTestOverrides(null);
  routes.clear();
  vi.unstubAllEnvs();
});

const send =
  (status: number, headers: Record<string, string>, body: Buffer | string = ""): Handler =>
  (_q, s) => {
    s.writeHead(status, headers);
    s.end(body);
  };

describe("policy", () => {
  it("allows public unicast, denies every special range", () => {
    for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"])
      expect(isAllowedAddress(a)).toBe(true);
    for (const a of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.1.1",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.5",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.9",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      "::127.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:7f00:1::",
      "2001::1",
      "2001:db8::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "fe80::1%eth0",
      "fec0::1",
      "ff02::1",
      "4000::1",
      "3fff::1",
      "not-an-ip",
      "",
    ]) {
      expect(isAllowedAddress(a), a).toBe(false);
    }
  });

  it("denies internal and special-use hostnames", () => {
    for (const h of [
      "example.com",
      "cdn.shop.example.co.uk",
      "images.vercel.app",
      "xn--80ak6aa92e.com",
    ])
      expect(isAllowedHostname(h), h).toBe(true);
    for (const h of [
      "localhost",
      "foo.localhost",
      "metadata.google.internal",
      "metadata",
      "printer.local",
      "svc.internal",
      "x.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "a.test",
      "a.example",
      "a.invalid",
      "abc.onion",
      "intranet",
      "single",
      "com",
      "a..b.com",
      "-bad.com",
      "kubernetes.default.svc",
      "",
    ]) {
      expect(isAllowedHostname(h), h).toBe(false);
    }
  });

  it("validates schemes, credentials, ports and every IPv4/IPv6 literal form", () => {
    const cases: Array<[string, string]> = [
      ["ftp://example.com/a", "bad_scheme"],
      ["file:///etc/passwd", "bad_scheme"],
      ["javascript:alert(1)", "bad_scheme"],
      ["data:image/png;base64,AAAA", "bad_scheme"],
      ["//example.com/a", "bad_url"],
      ["http://user:pw@example.com/", "bad_url"],
      ["http://example.com:8080/", "bad_port"],
      ["https://example.com:80/", "bad_port"],
      ["http://example.com:22/", "bad_port"],
      ["http://127.0.0.1/", "blocked_address"],
      ["http://2130706433/", "blocked_address"],
      ["http://0x7f.0.0.1/", "blocked_address"],
      ["http://0177.0.0.1/", "blocked_address"],
      ["http://127.1/", "blocked_address"],
      ["http://%31%32%37.0.0.1/", "blocked_address"],
      ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
      ["http://[::1]/", "blocked_address"],
      ["http://[::ffff:127.0.0.1]/", "blocked_address"],
      ["http://[::ffff:a9fe:a9fe]/", "blocked_address"],
      ["http://[fe80::1%25eth0]/", "bad_url"],
      ["http://localhost/", "blocked_host"],
      ["http://metadata.google.internal/computeMetadata/v1/", "blocked_host"],
    ];
    for (const [u, err] of cases) expect(validateTarget(u), u).toEqual({ ok: false, error: err });
    expect(validateTarget("https://example.com/a.png#frag")).toMatchObject({ ok: true });
  });
});

describe("safeFetch against local servers", () => {
  it("fetches an image, sends no cookies/auth/referrer and a fixed UA", async () => {
    trusted();
    routes.set("/a.png", send(200, { "content-type": "image/png" }, png(20, 10)));
    const r = await fetchImage(`${BASE()}/a.png`, { maxBytes: 100_000 });
    expect(r).toMatchObject({
      ok: true,
      format: "png",
      width: 20,
      height: 10,
      contentType: "image/png",
    });
    const h = seenHeaders[seenHeaders.length - 1]!;
    expect(h["user-agent"]).toBe(SAFE_FETCH_USER_AGENT);
    expect(h.cookie).toBeUndefined();
    expect(h.authorization).toBeUndefined();
    expect(h.referer).toBeUndefined();
    expect(h.host).toBe(`img.test:${port}`);
  });

  it("serves the sniffed content type, not the upstream one", async () => {
    trusted();
    routes.set("/lie", send(200, { "content-type": "image/svg+xml" }, png(5, 5)));
    expect(await fetchImage(`${BASE()}/lie`, { maxBytes: 10_000 })).toMatchObject({
      ok: true,
      contentType: "image/png",
    });
  });

  it("rejects content-type mismatches, SVG and non-images", async () => {
    trusted();
    routes.set("/html", send(200, { "content-type": "text/html" }, "<script>x</script>"));
    routes.set("/none", (_q, s) => {
      s.removeHeader("content-type");
      s.writeHead(200);
      s.end("x");
    });
    routes.set("/svg", send(200, { "content-type": "image/svg+xml" }, SVG));
    routes.set("/fake", send(200, { "content-type": "image/png" }, "definitely not a png"));
    expect(await safeFetch(`${BASE()}/html`, IMG)).toMatchObject({
      ok: false,
      error: "content_type",
    });
    expect(await safeFetch(`${BASE()}/none`, IMG)).toMatchObject({
      ok: false,
      error: "content_type",
    });
    // An SVG is flagged (the render pre-fetch reports it as a format Gmail doesn't show).
    expect(await fetchImage(`${BASE()}/svg`, { maxBytes: 10_000 })).toMatchObject({
      ok: false,
      reason: "not_image",
      svg: true,
    });
    const fake = await fetchImage(`${BASE()}/fake`, { maxBytes: 10_000 });
    expect(fake).toMatchObject({ ok: false, reason: "not_image" });
    expect(fake).not.toHaveProperty("svg");
  });

  it("fetchImage tolerates generic/missing content types but still sniffs the bytes", async () => {
    trusted();
    routes.set("/s3.png", send(200, { "content-type": "binary/octet-stream" }, png(7, 3)));
    routes.set("/octet.png", send(200, { "content-type": "Application/Octet-Stream" }, png(2, 2)));
    routes.set("/odd.png", send(200, { "content-type": "audio/unknown" }, png(2, 2)));
    routes.set("/untyped.png", (_q, s) => {
      s.removeHeader("content-type");
      s.writeHead(200);
      s.end(png(4, 4));
    });
    routes.set("/octet.html", send(200, { "content-type": "binary/octet-stream" }, "<svg/>"));
    routes.set("/html.png", send(200, { "content-type": "text/html" }, png(2, 2)));
    routes.set("/audio.png", send(200, { "content-type": "audio/mpeg" }, png(2, 2)));
    const ok = { ok: true, format: "png", contentType: "image/png" };
    expect(await fetchImage(`${BASE()}/s3.png`, { maxBytes: 10_000 })).toMatchObject({
      ...ok,
      width: 7,
      height: 3,
    });
    expect(await fetchImage(`${BASE()}/octet.png`, { maxBytes: 10_000 })).toMatchObject(ok);
    expect(await fetchImage(`${BASE()}/odd.png`, { maxBytes: 10_000 })).toMatchObject(ok);
    expect(await fetchImage(`${BASE()}/untyped.png`, { maxBytes: 10_000 })).toMatchObject(ok);
    // The bytes still decide: a non-image body with a generic type is refused.
    expect(await fetchImage(`${BASE()}/octet.html`, { maxBytes: 10_000 })).toMatchObject({
      ok: false,
      reason: "not_image",
      svg: true,
    });
    // Specific non-image types stay refused before the body is read.
    for (const p of ["/html.png", "/audio.png"]) {
      expect(await fetchImage(`${BASE()}${p}`, { maxBytes: 10_000 })).toMatchObject({
        ok: false,
        reason: "content_type",
      });
    }
    // Plain safeFetch without `tolerate` is unchanged.
    expect(await safeFetch(`${BASE()}/s3.png`, IMG)).toMatchObject({
      ok: false,
      error: "content_type",
    });
    expect(
      await safeFetch(`${BASE()}/s3.png`, { ...IMG, tolerate: ["binary/octet-stream"] }),
    ).toMatchObject({ ok: true, contentType: "binary/octet-stream" });
  });

  it("retries a connection dropped before any response once, and only once", async () => {
    trusted();
    let flaky = 0;
    routes.set("/flaky.png", (q, s) => {
      if (flaky++ === 0) q.socket.destroy();
      else send(200, { "content-type": "image/png" }, png(3, 3))(q, s);
    });
    let dead = 0;
    routes.set("/dead.png", (q) => {
      dead++;
      q.socket.destroy();
    });
    expect(await fetchImage(`${BASE()}/flaky.png`, { maxBytes: 10_000 })).toMatchObject({
      ok: true,
      width: 3,
    });
    expect(flaky).toBe(2);
    expect(await fetchImage(`${BASE()}/dead.png`, { maxBytes: 10_000 })).toMatchObject({
      ok: false,
      reason: "network",
    });
    expect(dead).toBe(2);
    // No retry when too little of the deadline is left.
    dead = 0;
    expect(await safeFetch(`${BASE()}/dead.png`, { ...IMG, timeoutMs: 1000 })).toMatchObject({
      ok: false,
      error: "network",
    });
    expect(dead).toBe(1);
    // HTTP errors are answers, not connection failures: never retried.
    let gone = 0;
    routes.set("/gone.png", (q, s) => {
      gone++;
      send(404, {})(q, s);
    });
    expect(await safeFetch(`${BASE()}/gone.png`, IMG)).toMatchObject({
      error: "http",
      status: 404,
    });
    expect(gone).toBe(1);
  });

  it("rejects images above 25 megapixels", async () => {
    trusted();
    routes.set("/huge", send(200, { "content-type": "image/png" }, png(10_000, 10_000)));
    expect(await fetchImage(`${BASE()}/huge`, { maxBytes: 10_000 })).toMatchObject({
      ok: false,
      reason: "too_many_pixels",
    });
  });

  it("maps HTTP errors", async () => {
    trusted();
    expect(await safeFetch(`${BASE()}/missing`, IMG)).toEqual({
      ok: false,
      error: "http",
      status: 404,
    });
  });

  it("blocks redirects to loopback, metadata, mapped IPv6, internal names and bad schemes/ports", async () => {
    trusted();
    const targets: Array<[string, string]> = [
      [`http://127.0.0.1:${port}/a.png`, "blocked_address"],
      ["http://169.254.169.254/latest/meta-data/", "blocked_address"],
      [`http://[::ffff:127.0.0.1]:${port}/`, "blocked_address"],
      [`http://localhost:${port}/`, "blocked_host"],
      ["file:///etc/passwd", "bad_scheme"],
      ["http://example.com:6379/", "bad_port"],
    ];
    routes.set("/a.png", send(200, { "content-type": "image/png" }, png(1, 1)));
    for (const [loc, err] of targets) {
      routes.set("/r", send(302, { location: loc }));
      expect(await safeFetch(`${BASE()}/r`, IMG), loc).toEqual({ ok: false, error: err });
    }
  });

  it("follows at most 3 redirects, re-validating each", async () => {
    trusted();
    routes.set("/ok.png", send(200, { "content-type": "image/png" }, png(2, 2)));
    routes.set("/r1", send(301, { location: "/r2" }));
    routes.set("/r2", send(302, { location: "/r3" }));
    routes.set("/r3", send(307, { location: `${BASE()}/ok.png` }));
    routes.set("/loop", send(302, { location: "/loop" }));
    expect(await safeFetch(`${BASE()}/r1`, IMG)).toMatchObject({
      ok: true,
      finalUrl: `${BASE()}/ok.png`,
    });
    expect(await safeFetch(`${BASE()}/loop`, IMG)).toMatchObject({ ok: false, error: "redirects" });
    expect(await safeFetch(`${BASE()}/r1`, { ...IMG, maxRedirects: 1 })).toMatchObject({
      ok: false,
      error: "redirects",
    });
  });

  it("DNS rebinding: a public-looking name resolving to a private address is blocked at connect time", async () => {
    const calls: string[] = [];
    trusted({
      resolve: async (h) => {
        calls.push(h);
        return h === "mixed.example.com"
          ? [
              { address: "93.184.216.34", family: 4 },
              { address: "10.0.0.5", family: 4 },
            ]
          : [{ address: "127.0.0.1", family: 4 }];
      },
    });
    routes.set("/r", send(302, { location: `http://rebind.example.com:${port}/x.png` }));
    expect(await safeFetch(`${BASE()}/r`, IMG)).toEqual({ ok: false, error: "blocked_address" });
    expect(await safeFetch(`http://rebind.example.com:${port}/x.png`, IMG)).toEqual({
      ok: false,
      error: "blocked_address",
    });
    expect(await safeFetch(`http://mixed.example.com:${port}/x.png`, IMG)).toEqual({
      ok: false,
      error: "blocked_address",
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("aborts oversize bodies (declared and streamed)", async () => {
    trusted();
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    routes.set(
      "/declared",
      send(200, { "content-type": "image/png", "content-length": String(big.length) }, big),
    );
    routes.set("/streamed", (_q, s) => {
      s.writeHead(200, { "content-type": "image/png" });
      let sent = 0;
      const pump = (): void => {
        while (sent < big.length) {
          sent += 64 * 1024;
          if (!s.write(big.subarray(0, 64 * 1024))) {
            s.once("drain", pump);
            return;
          }
        }
        s.end();
      };
      pump();
    });
    expect(await safeFetch(`${BASE()}/declared`, IMG)).toMatchObject({
      ok: false,
      error: "too_large",
    });
    expect(await safeFetch(`${BASE()}/streamed`, IMG)).toMatchObject({
      ok: false,
      error: "too_large",
    });
  });

  it("caps decompressed bytes: a gzip bomb is aborted quickly", async () => {
    trusted();
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(200 * 1024);
    routes.set(
      "/bomb",
      send(200, { "content-type": "image/png", "content-encoding": "gzip" }, bomb),
    );
    routes.set(
      "/double",
      send(
        200,
        { "content-type": "image/png", "content-encoding": "gzip, gzip" },
        gzipSync(gzipSync("x")),
      ),
    );
    const t0 = Date.now();
    expect(await safeFetch(`${BASE()}/bomb`, IMG)).toMatchObject({ ok: false, error: "too_large" });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await safeFetch(`${BASE()}/double`, IMG)).toMatchObject({
      ok: false,
      error: "content_type",
    });
  });

  it("decodes legitimate gzip responses", async () => {
    trusted();
    routes.set(
      "/gz.png",
      send(200, { "content-type": "image/png", "content-encoding": "gzip" }, gzipSync(png(3, 4))),
    );
    expect(await fetchImage(`${BASE()}/gz.png`, { maxBytes: 10_000 })).toMatchObject({
      ok: true,
      width: 3,
      height: 4,
    });
  });

  it("times out slow-loris bodies and missing headers", async () => {
    trusted();
    routes.set("/drip", (_q, s) => {
      s.writeHead(200, { "content-type": "image/png" });
      const t = setInterval(() => s.write("x"), 50);
      s.on("close", () => clearInterval(t));
    });
    routes.set("/silent", () => {
      /* never answers */
    });
    const t0 = Date.now();
    expect(await safeFetch(`${BASE()}/drip`, { ...IMG, timeoutMs: 400 })).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(await safeFetch(`${BASE()}/silent`, { ...IMG, timeoutMs: 400 })).toEqual({
      ok: false,
      error: "timeout",
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("limits concurrency to 4 per host", async () => {
    trusted();
    maxActive = 0;
    routes.set("/slow.png", (_q, s) => {
      setTimeout(() => {
        s.writeHead(200, { "content-type": "image/png" });
        s.end(png(1, 1));
      }, 100);
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => safeFetch(`${BASE()}/slow.png`, IMG)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it("ignores proxy environment variables", async () => {
    trusted();
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("http_proxy", "http://127.0.0.1:9");
    routes.set("/p.png", send(200, { "content-type": "image/png" }, png(1, 1)));
    expect(await safeFetch(`${BASE()}/p.png`, IMG)).toMatchObject({ ok: true });
  });

  it("rejects invalid options loudly", async () => {
    await expect(
      safeFetch("https://example.com/", { accept: ["image/"], maxBytes: 15 * 1024 * 1024 + 1 }),
    ).rejects.toThrow();
    await expect(safeFetch("https://example.com/", { accept: [], maxBytes: 10 })).rejects.toThrow();
  });
});

describe("deadlines cover DNS, connect and TLS", () => {
  let stall: ReturnType<typeof createTcpServer>;
  let stallPort = 0;
  const held: Socket[] = [];

  beforeAll(async () => {
    // Accepts TCP connections and never says a word, so a TLS handshake never completes.
    stall = createTcpServer((sock) => {
      held.push(sock);
      sock.on("error", () => undefined);
    });
    await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
    stallPort = (stall.address() as AddressInfo).port;
  });

  afterAll(async () => {
    for (const sock of held) sock.destroy();
    await new Promise<void>((r) => stall.close(() => r()));
  });

  it("a DNS lookup that never answers ends at timeoutMs, not the connect timeout", async () => {
    trusted({ resolve: () => new Promise<LookupAddress[]>(() => undefined) });
    const t0 = Date.now();
    expect(
      await safeFetch(`http://hang.example.com:${port}/x.png`, { ...IMG, timeoutMs: 400 }),
    ).toEqual({ ok: false, error: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("a stalled TLS handshake ends at the header budget, not the connect timeout", async () => {
    setTestOverrides({
      trustedHosts: new Map([["tls.test", "127.0.0.1"]]),
      extraPorts: [stallPort],
    });
    const t0 = Date.now();
    expect(
      await safeFetch(`https://tls.test:${stallPort}/x.png`, { ...IMG, timeoutMs: 400 }),
    ).toEqual({ ok: false, error: "timeout" });
    expect(Date.now() - t0).toBeLessThan(1500);
    const t1 = Date.now();
    expect(
      await safeFetch(`https://tls.test:${stallPort}/x.png`, { ...IMG, timeoutMs: 5000 }),
    ).toEqual({ ok: false, error: "timeout" });
    const took = Date.now() - t1;
    expect(took).toBeGreaterThanOrEqual(2900);
    expect(took).toBeLessThan(4000);
  }, 10_000);

  it("an abandoned connection attempt keeps its per-host slot until it ends", async () => {
    setTestOverrides({
      trustedHosts: new Map([["slots.test", "127.0.0.1"]]),
      extraPorts: [stallPort],
    });
    const before = held.length;
    const call = (scheme: string) =>
      safeFetch(`${scheme}://slots.test:${stallPort}/x.png`, { ...IMG, timeoutMs: 300 });
    const timeouts = Array.from({ length: 4 }, () => ({ ok: false, error: "timeout" }));
    expect(await Promise.all(Array.from({ length: 4 }, () => call("https")))).toEqual(timeouts);
    // Same host, other origin: the four TLS attempts are still connecting, so no slot is free.
    expect(await Promise.all(Array.from({ length: 4 }, () => call("http")))).toEqual(timeouts);
    expect(held.length - before).toBe(4);
  });
});

describe("DNS resolution (c-ares, cancellable)", () => {
  let dnsServer: UdpSocket;
  let dnsPort = 0;
  const queried: string[] = [];
  // name → A records and zone6 → AAAA records (fully expanded); "nx.example.com" is NXDOMAIN;
  // anything under blackhole.example.com is dropped, and so are AAAA queries under
  // noaaaa.example.com and A queries under dropa.example.com; A answers under slowa.example.com
  // come 700 ms after the AAAA answer (still inside c-ares' first 1000 ms attempt).
  const zone = new Map([
    ["public.example.com", ["93.184.216.34"]],
    ["private.example.com", ["10.0.0.5"]],
    ["v4.noaaaa.example.com", ["93.184.216.35"]],
    ["dual.slowa.example.com", ["93.184.216.36"]],
  ]);
  const zone6 = new Map([
    ["dual.slowa.example.com", ["2606:2800:0220:0001:0248:1893:25c8:1946"]],
    ["v6only.example.com", ["2606:2800:0220:0001:0248:1893:25c8:1947"]],
    ["dual.dropa.example.com", ["2606:2800:0220:0001:0248:1893:25c8:1948"]],
  ]);

  beforeAll(async () => {
    dnsServer = createSocket("udp4");
    dnsServer.on("message", (msg, rinfo) => {
      let end = 12;
      const labels: string[] = [];
      while (msg[end] !== 0) {
        const len = msg[end] as number;
        labels.push(msg.subarray(end + 1, end + 1 + len).toString("latin1"));
        end += len + 1;
      }
      end += 5; // root label + QTYPE + QCLASS
      const name = labels.join(".").toLowerCase();
      const qtype = msg.readUInt16BE(end - 4);
      queried.push(name);
      if (name.endsWith("blackhole.example.com")) return;
      if (qtype === 28 && name.endsWith("noaaaa.example.com")) return;
      if (qtype === 1 && name.endsWith("dropa.example.com")) return;
      const answers = (qtype === 1 ? zone.get(name) : qtype === 28 ? zone6.get(name) : []) ?? [];
      const header = Buffer.alloc(12);
      msg.copy(header, 0, 0, 2);
      header.writeUInt16BE(zone.has(name) || zone6.has(name) ? 0x8180 : 0x8183, 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(answers.length, 6);
      const records = answers.map((ip) => {
        const v6 = qtype === 28;
        const rr = Buffer.alloc(v6 ? 28 : 16);
        rr.writeUInt16BE(0xc00c, 0);
        rr.writeUInt16BE(qtype, 2);
        rr.writeUInt16BE(1, 4);
        rr.writeUInt32BE(60, 6);
        rr.writeUInt16BE(v6 ? 16 : 4, 10);
        if (v6) ip.split(":").forEach((g, i) => rr.writeUInt16BE(parseInt(g, 16), 12 + 2 * i));
        else ip.split(".").forEach((o, i) => rr.writeUInt8(Number(o), 12 + i));
        return rr;
      });
      const reply = Buffer.concat([header, msg.subarray(12, end), ...records]);
      const delay = qtype === 1 && name.endsWith("slowa.example.com") ? 700 : 0;
      setTimeout(() => dnsServer.send(reply, rinfo.port, rinfo.address), delay);
    });
    await new Promise<void>((r) => dnsServer.bind(0, "127.0.0.1", r));
    dnsPort = dnsServer.address().port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => dnsServer.close(() => r()));
  });

  const lookupAll = (host: string) =>
    new Promise<{ err: NodeJS.ErrnoException | null; addrs: LookupAddress[] }>((resolve) => {
      safeLookup(host, { all: true }, (err, addrs) =>
        resolve({ err, addrs: (addrs as unknown as LookupAddress[]) ?? [] }),
      );
    });

  it("resolves A/AAAA through the resolver and validates every address", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    expect(await lookupAll("public.example.com")).toEqual({
      err: null,
      addrs: [{ address: "93.184.216.34", family: 4 }],
    });
    expect((await lookupAll("private.example.com")).err?.code).toBe("EDF_BLOCKED_ADDRESS");
    expect((await lookupAll("nx.example.com")).err?.code).toBe("ENOTFOUND");
    expect(await lookupAll("v6only.example.com")).toEqual({
      err: null,
      addrs: [{ address: "2606:2800:220:1:248:1893:25c8:1947", family: 6 }],
    });
    expect(queried).toContain("public.example.com");
  });

  it("an early AAAA answer never cuts the A lookup short (IPv4-only egress)", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    expect(await lookupAll("dual.slowa.example.com")).toEqual({
      err: null,
      addrs: [
        { address: "93.184.216.36", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    });
  });

  it("an IPv6-only answer is not used when A never came back (IPv4-only egress)", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    const t0 = Date.now();
    expect((await lookupAll("dual.dropa.example.com")).err?.code).toBe("EAI_AGAIN"); // "dns"
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 10_000);

  it("an answered A is returned promptly when AAAA never comes back", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    const t0 = Date.now();
    expect(await lookupAll("v4.noaaaa.example.com")).toEqual({
      err: null,
      addrs: [{ address: "93.184.216.35", family: 4 }],
    });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("a nameserver that never answers is cancelled in bounded time and holds no threadpool slot", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    const t0 = Date.now();
    const lookups = Array.from({ length: 8 }, (_, i) => lookupAll(`a${i}.blackhole.example.com`));
    // No getaddrinfo request (libuv threadpool, uncancellable) was started for these lookups...
    expect(process.getActiveResourcesInfo()).not.toContain("GetAddrInfoReqWrap");
    // ...so zlib, which shares that pool, stays responsive while they are pending.
    const z0 = Date.now();
    await promisify(gzip)(Buffer.alloc(1024));
    expect(Date.now() - z0).toBeLessThan(500);
    const results = await Promise.all(lookups);
    expect(results.every((r) => r.err?.code === "EAI_AGAIN")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(queried).toContain("a7.blackhole.example.com");
    const sent = queried.length;
    await new Promise((r) => setTimeout(r, 1200));
    expect(queried.length).toBe(sent); // cancelled: no retries after giving up
  }, 10_000);

  it("a nameserver that never answers fails the fetch as dns within its deadline, else timeout", async () => {
    setTestOverrides({ dnsServers: [`127.0.0.1:${dnsPort}`] });
    const t0 = Date.now();
    expect(
      await safeFetch("http://b1.blackhole.example.com/x.png", { ...IMG, timeoutMs: 5000 }),
    ).toEqual({ ok: false, error: "dns" });
    expect(Date.now() - t0).toBeLessThan(2900);
    expect(
      await safeFetch("http://b2.blackhole.example.com/x.png", { ...IMG, timeoutMs: 400 }),
    ).toEqual({ ok: false, error: "timeout" });
  }, 10_000);
});
