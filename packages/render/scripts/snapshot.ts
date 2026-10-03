/**
 * Builds the render snapshot (FREE-TIER.md §5.1 "The snapshot holds", §11 step 7):
 * pinned Chrome for Testing (matching puppeteer-core 25.12.0), the metric-compatible font bundle
 * (Arimo, Tinos, Cousine, Gelasio, Roboto, Noto Sans/Serif/Color Emoji/CJK), pinned
 * puppeteer-core / sharp / axe-core / DOMPurify / jsdom, and dist/render.js. Then it runs the
 * font smoke test (incl. the `__default__` sentinel), the Chromium-sandbox check and the
 * deny-all probe, and snapshots with `expiration: 0`.
 *
 *   pnpm --filter @edf/render build && pnpm --filter @edf/render render-vm:snapshot
 *
 * Needs Vercel credentials (`vercel env pull` → VERCEL_OIDC_TOKEN). Prints only build status
 * and the snapshot id. Written against @vercel/sandbox 3.5.0 typings; not executed in CI.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@vercel/sandbox";

const here = dirname(fileURLToPath(import.meta.url));
const APP = "/vercel/sandbox/edf";

/** Pins (bump together with packages/render/package.json and RENDERER_VERSION). */
const PINS = {
  chromeHeadlessShell: "154.0.8037.57", // puppeteer-core 25.12.0 PUPPETEER_REVISIONS
  puppeteerBrowsers: "3.2.3",
  deps: {
    "puppeteer-core": "25.12.0",
    sharp: "0.35.4",
    "axe-core": "4.13.0",
    dompurify: "3.4.16",
    jsdom: "30.1.1",
  },
} as const;

/** Build-time network allowlist; switched to deny-all before the probe and the snapshot. */
const BUILD_ALLOW = [
  "registry.npmjs.org",
  "storage.googleapis.com",
  "googlechromelabs.github.io",
  "raw.githubusercontent.com",
  "deb.debian.org",
  "security.debian.org",
  "archive.ubuntu.com",
  "security.ubuntu.com",
];

const APT_PACKAGES = [
  "ca-certificates",
  "curl",
  "unzip",
  "fontconfig",
  "fonts-croscore",
  "fonts-roboto",
  "fonts-noto-core",
  "fonts-noto-color-emoji",
  "fonts-noto-cjk",
  "libnss3",
  "libatk1.0-0",
  "libatk-bridge2.0-0",
  "libcups2",
  "libdrm2",
  "libxkbcommon0",
  "libxcomposite1",
  "libxdamage1",
  "libxfixes3",
  "libxrandr2",
  "libgbm1",
  "libpango-1.0-0",
  "libcairo2",
];

const FONT_ALIASES = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias binding="same"><family>Arial</family><prefer><family>Arimo</family></prefer></alias>
  <alias binding="same"><family>Helvetica</family><prefer><family>Arimo</family></prefer></alias>
  <alias binding="same"><family>Times New Roman</family><prefer><family>Tinos</family></prefer></alias>
  <alias binding="same"><family>Times</family><prefer><family>Tinos</family></prefer></alias>
  <alias binding="same"><family>Courier New</family><prefer><family>Cousine</family></prefer></alias>
  <alias binding="same"><family>Courier</family><prefer><family>Cousine</family></prefer></alias>
  <alias binding="same"><family>Georgia</family><prefer><family>Gelasio</family></prefer></alias>
</fontconfig>
`;

/** In-VM smoke test: platform fonts per family, the `__default__` sentinel, Chromium sandbox. */
const SMOKE = `import puppeteer from "puppeteer-core";
import { readFileSync } from "node:fs";
const exe = readFileSync("${APP}/chrome-path.txt", "utf8").trim();
const html = '<!doctype html><html><head><style>:where(html){font-family:"__default__"}</style></head><body>' +
  '<span id="arial" style="font-family:Arial">Arial</span> <span id="georgia" style="font-family:Georgia">Georgia</span> ' +
  '<span id="roboto" style="font-family:Roboto">Roboto</span> <span id="emoji">&#x1F600;</span> <span id="cjk">&#x6F22;&#x5B57;</span>' +
  '<p id="unset">No font set</p></body></html>';
async function run(noSandbox) {
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, args: noSandbox ? ["--no-sandbox"] : [] });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (r) => r.url() === "https://smoke.invalid/" ? r.respond({ status: 200, contentType: "text/html", body: html }) : r.abort());
    await page.goto("https://smoke.invalid/", { waitUntil: "load" });
    const cdp = await page.createCDPSession();
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument");
    const fonts = {};
    for (const id of ["arial", "georgia", "roboto", "emoji", "cjk"]) {
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#" + id });
      const r = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
      fonts[id] = r.fonts.map((f) => f.familyName);
    }
    const snap = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: ["font-family"] });
    const d = snap.documents[0];
    const unset = d.layout.styles.map((s) => snap.strings[s[0]]).includes("__default__");
    return { fonts, unset };
  } finally {
    await browser.close();
  }
}
const expect = { arial: /Arimo/, georgia: /Gelasio/, roboto: /Roboto/, emoji: /Noto Color Emoji/, cjk: /Noto (Sans|Serif) CJK/ };
let sandbox = "on";
let r;
try { r = await run(false); } catch { sandbox = "unavailable"; r = await run(true); }
const bad = Object.entries(expect).filter(([k, re]) => !(r.fonts[k] || []).some((n) => re.test(n))).map(([k]) => k);
console.log("smoke fonts:" + (bad.length === 0 ? "ok" : "missing " + bad.join(",")));
console.log("smoke sentinel:" + (r.unset ? "ok" : "missing"));
console.log("chromium-sandbox:" + sandbox);
process.exit(bad.length === 0 && r.unset ? 0 : 1);
`;

const PROBE = `import dns from "node:dns/promises";
import net from "node:net";
let dnsOk = false, tcpOk = false;
try { await dns.lookup("registry.npmjs.org"); dnsOk = true; } catch {}
await new Promise((resolve) => {
  const s = net.connect({ host: "104.16.0.35", port: 443, timeout: 4000 }, () => { tcpOk = true; s.destroy(); resolve(); });
  s.on("error", () => resolve()); s.on("timeout", () => { s.destroy(); resolve(); });
});
console.log("deny-all probe: dns=" + (dnsOk ? "OPEN" : "blocked") + " tcp=" + (tcpOk ? "OPEN" : "blocked"));
process.exit(dnsOk || tcpOk ? 1 : 0);
`;

async function sh(
  sb: Sandbox,
  script: string,
  opts: { sudo?: boolean; step: string },
): Promise<string> {
  const done = await sb.runCommand({
    cmd: "bash",
    args: ["-lc", script],
    sudo: opts.sudo ?? false,
  });
  const out = await done.stdout();
  if (done.exitCode !== 0)
    throw new Error(
      `${opts.step} failed (exit ${done.exitCode}): ${(await done.stderr()).slice(-2000)}`,
    );
  return out;
}

async function main(): Promise<void> {
  const bundle = readFileSync(join(here, "../dist/render.js"));
  const sb = await Sandbox.create({
    image: "vercel/sandbox/node:24",
    persistent: false,
    networkPolicy: { allow: BUILD_ALLOW },
    resources: { vcpus: 2 },
    timeout: 30 * 60_000,
    tags: { edf: "snapshot-build" },
  });
  let snapshotted = false;
  try {
    await sh(
      sb,
      "command -v apt-get >/dev/null || { echo 'apt-get not found: pick a Debian/Ubuntu-based image' >&2; exit 1; }",
      { step: "distro check" },
    );
    // The build allowlist is enforced on TLS (SNI), so plain-HTTP package mirrors can't be reached:
    // point apt at the same hosts over HTTPS (both Ubuntu and Debian serve their archives on 443).
    await sh(
      sb,
      `export DEBIAN_FRONTEND=noninteractive; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do [ -f "$f" ] && sed -i -E 's#http://(archive\\.ubuntu\\.com|security\\.ubuntu\\.com|deb\\.debian\\.org|security\\.debian\\.org)#https://\\1#g' "$f"; done; apt-get update -qq && apt-get install -y -qq --no-install-recommends ${APT_PACKAGES.join(" ")} && (apt-get install -y -qq libasound2t64 || apt-get install -y -qq libasound2)`,
      {
        sudo: true,
        step: "system packages",
      },
    );
    await sh(
      sb,
      "mkdir -p /usr/local/share/fonts/gelasio && curl -fsSL -o /usr/local/share/fonts/gelasio/Gelasio.ttf 'https://raw.githubusercontent.com/google/fonts/main/ofl/gelasio/Gelasio%5Bwght%5D.ttf' && sha256sum /usr/local/share/fonts/gelasio/Gelasio.ttf",
      { sudo: true, step: "Gelasio" },
    );
    await sb.writeFiles([
      { path: "/tmp/99-edf-metric-aliases.conf", content: FONT_ALIASES },
      {
        path: `${APP}/package.json`,
        content: JSON.stringify(
          { name: "edf-render-vm", private: true, type: "module", dependencies: PINS.deps },
          null,
          2,
        ),
      },
      { path: `${APP}/render.js`, content: bundle },
      { path: `${APP}/smoke.mjs`, content: SMOKE },
      { path: `${APP}/probe.mjs`, content: PROBE },
    ]);
    await sh(
      sb,
      "install -m 644 /tmp/99-edf-metric-aliases.conf /etc/fonts/conf.d/99-edf-metric-aliases.conf && fc-cache -f",
      { sudo: true, step: "fontconfig" },
    );
    await sh(
      sb,
      `cd ${APP} && npm install --omit=dev --ignore-scripts --no-audit --no-fund --save-exact`,
      { step: "npm install" },
    );
    const chrome = await sh(
      sb,
      `cd ${APP} && npx --yes @puppeteer/browsers@${PINS.puppeteerBrowsers} install chrome-headless-shell@${PINS.chromeHeadlessShell} --path ${APP}/chrome --format '{{path}}'`,
      { step: "chrome-headless-shell" },
    );
    const chromePath = chrome.trim().split("\n").pop() ?? "";
    if (!chromePath.startsWith(APP)) throw new Error("unexpected chrome path");
    await sb.writeFiles([{ path: `${APP}/chrome-path.txt`, content: chromePath }]);
    await sh(sb, `mkdir -p ${APP}/jobs ${APP}/out`, { step: "dirs" });

    console.log((await sh(sb, `cd ${APP} && node smoke.mjs`, { step: "font smoke test" })).trim());

    // Install phase over: lock the network down and prove it, before any email is ever written.
    await sb.update({ networkPolicy: "deny-all" });
    console.log((await sh(sb, `cd ${APP} && node probe.mjs`, { step: "deny-all probe" })).trim());

    const snap = await sb.snapshot({ expiration: 0 });
    snapshotted = true;
    console.log(`SANDBOX_SNAPSHOT_ID=${snap.snapshotId}`);
  } finally {
    if (!snapshotted) await sb.stop().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "snapshot build failed");
  process.exit(1);
});
