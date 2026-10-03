import { describe, expect, it, vi } from "vitest";
import type { RenderJob } from "@edf/design";
import { assertSafeArgs, CHROMIUM_ARGS } from "../src/chromium";
import { stripMediaRules } from "../src/css";
import { cssUrls } from "../src/extract";
import { mergeSlivers } from "../src/pixels";
import {
  SandboxHygieneError,
  SandboxRenderer,
  assertSandboxHygiene,
  sandboxUsage,
  sweepSandboxes,
  type SandboxFactory,
  type SandboxHandle,
  type SandboxListing,
  type SandboxOps,
} from "../src/sandbox";
import { imageHeader, parseResultFile, toResultFile } from "../src/vm/protocol";

const job = (id = "email-1", wantAiTiles = true): RenderJob => ({
  id,
  html: "<p>hi</p>",
  images: {},
  cid: {},
  imageLog: {},
  imagesAllowed: true,
  wantAiTiles,
  lite: false,
});

describe("chromium flags (DESIGN.md §6.2)", () => {
  it("adds the hardening flags and rejects the insecure Sparticuz defaults", () => {
    for (const f of [
      "--disable-background-networking",
      "--dns-prefetch-disable",
      "--js-flags=--jitless",
      "--disk-cache-size=0",
    ])
      expect(CHROMIUM_ARGS).toContain(f);
    expect(() => assertSafeArgs(CHROMIUM_ARGS)).not.toThrow();
    expect(() => assertSafeArgs(["--disable-web-security"])).toThrow();
    expect(() => assertSafeArgs(["--allow-running-insecure-content"])).toThrow();
    expect(() => assertSafeArgs(["--disable-site-isolation-trials"])).toThrow();
  });
});

describe("M-nomq: stripMediaRules", () => {
  it("removes every @media block, nested braces, keeps strings/comments intact", () => {
    const css = `a{color:red} @media screen and (max-width:600px){ .p{padding:0!important} .q{content:"}"} } b{x:1} /* @media fake{ } */ @MEDIA print{c{d:e}}`;
    expect(stripMediaRules(css)).toBe(`a{color:red}  b{x:1} /* @media fake{ } */ `);
    expect(stripMediaRules("@supports (display:grid){@media (min-width:1px){a{b:c}} d{e:f}}")).toBe(
      "@supports (display:grid){ d{e:f}}",
    );
    expect(stripMediaRules("a{b:c} @media (x){ unterminated")).toBe("a{b:c} ");
  });
});

describe("background url()s (computed background-image)", () => {
  it("reads every url() whatever its length: a 5 MB picture inlined as a ~7M-character data: URI", () => {
    const big = `data:image/png;base64,${"A".repeat(Math.ceil((5 * 1024 * 1024 * 4) / 3))}`;
    expect(cssUrls(`url("${big}")`)).toEqual([big]);
    expect(
      cssUrls(`linear-gradient(red, blue), url("${big}"), url("https://img.example.com/a.png")`),
    ).toEqual([big, "https://img.example.com/a.png"]);
  });

  it("keeps escaped quotes inside a url and ignores malformed ones", () => {
    expect(cssUrls('url("https://img.example.com/a\\"b.png")')).toEqual([
      'https://img.example.com/a\\"b.png',
    ]);
    expect(cssUrls("none")).toEqual([]);
    expect(cssUrls('url("")')).toEqual([]);
    expect(cssUrls('url("https://img.example.com/never-closed')).toEqual([]);
  });
});

describe("X–Y cut slivers", () => {
  it("merges segments below the minimum leaf size", () => {
    expect(
      mergeSlivers(
        [
          [0, 20],
          [30, 200],
          [210, 220],
        ],
        32,
      ),
    ).toEqual([[0, 220]]);
    expect(
      mergeSlivers(
        [
          [0, 10],
          [15, 25],
        ],
        32,
      ),
    ).toEqual([[0, 25]]);
    expect(
      mergeSlivers(
        [
          [0, 100],
          [120, 300],
        ],
        32,
      ),
    ).toEqual([
      [0, 100],
      [120, 300],
    ]);
  });
});

describe("VM result validation (untrusted)", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    ]).copy(b);
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return new Uint8Array(b);
  };
  it("reads image dimensions from headers only", () => {
    expect(imageHeader(png(600, 750))).toEqual({ type: "png", width: 600, height: 750 });
    const vp8x = new Uint8Array(30);
    vp8x.set(
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58],
      0,
    );
    vp8x.set([0x76, 0x01, 0x00, 0x9a, 0x02, 0x00], 24);
    expect(imageHeader(vp8x)).toEqual({ type: "webp", width: 375, height: 667 });
    expect(imageHeader(new Uint8Array([1, 2, 3]))).toBeNull();
  });
  it("rejects bad JSON, oversized files, id mismatches and invalid features", () => {
    expect(parseResultFile(null, job()).error).toBe("sandbox_error");
    expect(parseResultFile(new Uint8Array(Buffer.from("{nope")), job()).error).toBe(
      "invalid_features",
    );
    const bad = toResultFile({
      id: "other",
      ok: true,
      error: null,
      features: null,
      aiTiles: null,
      renderMs: 1,
      chromiumVersion: null,
    });
    expect(parseResultFile(new Uint8Array(Buffer.from(JSON.stringify(bad))), job()).error).toBe(
      "invalid_features",
    );
    const invalid = toResultFile({
      id: "email-1",
      ok: true,
      error: null,
      features: null,
      aiTiles: null,
      renderMs: 1,
      chromiumVersion: null,
    });
    expect(
      parseResultFile(
        new Uint8Array(
          Buffer.from(
            JSON.stringify({ ...invalid, features: { v: 1, layout: { desktopHeight: -1 } } }),
          ),
        ),
        job(),
      ).error,
    ).toBe("invalid_features");
    expect(parseResultFile(new Uint8Array(7 * 1024 * 1024), job()).error).toBe("invalid_features");
    const failed = toResultFile({
      id: "email-1",
      ok: false,
      error: "timeout",
      features: null,
      aiTiles: null,
      renderMs: 20000,
      chromiumVersion: "Chrome/148",
    });
    expect(
      parseResultFile(new Uint8Array(Buffer.from(JSON.stringify(failed))), job()),
    ).toMatchObject({ ok: false, error: "timeout", renderMs: 20000 });
    const unknownCode = { ...failed, error: "<script>alert(1)</script>" };
    expect(
      parseResultFile(new Uint8Array(Buffer.from(JSON.stringify(unknownCode))), job()).error,
    ).toBe("invalid_features");
  });
  it("drops tiles that aren't PNG/WebP within the expected dimensions", async () => {
    const { baseRender } = await import("../../design/test/helpers/factory");
    const file = toResultFile({
      id: "email-1",
      ok: true,
      error: null,
      features: baseRender(),
      aiTiles: {
        desktop: [png(600, 750), png(5000, 5000), new Uint8Array([1, 2, 3])],
        mobile: png(375, 667),
      },
      renderMs: 900,
      chromiumVersion: "Chrome/148",
    });
    const out = parseResultFile(new Uint8Array(Buffer.from(JSON.stringify(file))), job());
    expect(out.ok).toBe(true);
    expect(out.aiTiles?.desktop).toHaveLength(1);
    expect(out.aiTiles?.mobile).not.toBeNull();
    const noTiles = parseResultFile(
      new Uint8Array(Buffer.from(JSON.stringify(file))),
      job("email-1", false),
    );
    expect(noTiles.aiTiles).toBeNull();
  });
});

describe("SandboxRenderer (FREE-TIER.md §5.1)", () => {
  function fakeSandbox(over: Partial<{ persistent: boolean; networkPolicy: unknown }> = {}) {
    const files = new Map<string, string | Uint8Array>();
    const calls: string[] = [];
    let params: Parameters<SandboxFactory>[0] | null = null;
    const handle: SandboxHandle = {
      name: "sbx_generated",
      persistent: over.persistent ?? false,
      networkPolicy: over.networkPolicy ?? "deny-all",
      createdAt: new Date("2026-09-27T10:00:00Z"),
      vcpus: 2,
      writeFiles: async (fs) => {
        calls.push("writeFiles");
        for (const f of fs) files.set(f.path, f.content);
      },
      runCommand: async (p) => {
        calls.push(`run:${p.cmd} ${(p.args ?? []).join(" ")}`);
        return { exitCode: 0, stdout: async () => "EDF 0 ok\n" };
      },
      readFileToBuffer: async (f) => {
        calls.push(`read:${f.path}`);
        const { baseRender } = await import("../../design/test/helpers/factory");
        const out = toResultFile({
          id: "email-1",
          ok: true,
          error: null,
          features: baseRender(),
          aiTiles: null,
          renderMs: 800,
          chromiumVersion: "Chrome/148",
        });
        return f.path.endsWith("0000.json") ? Buffer.from(JSON.stringify(out)) : null;
      },
      stop: async () => {
        calls.push("stop");
      },
    };
    const factory: SandboxFactory = async (p) => {
      params = p;
      return handle;
    };
    return { factory, files, calls, params: () => params };
  }

  it("creates a non-persistent, deny-all, 2-vCPU VM from the snapshot and always stops it", async () => {
    const fake = fakeSandbox();
    const r = new SandboxRenderer({
      snapshotId: "snap_123",
      factory: fake.factory,
      bundle: "console.log(1)",
      now: () => Date.parse("2026-09-27T10:00:00Z"),
    });
    const out = await r.renderBatch([job(), job("email-2")], { deadlineMs: 200_000 });
    expect(fake.params()).toEqual({
      source: { type: "snapshot", snapshotId: "snap_123" },
      persistent: false,
      networkPolicy: "deny-all",
      resources: { vcpus: 2 },
      timeout: 215_000,
      tags: { edf: "render" },
    });
    expect(out[0]?.ok).toBe(true);
    expect(out[1]).toMatchObject({ ok: false, error: "sandbox_error" });
    expect([...fake.files.keys()]).toEqual([
      "/vercel/sandbox/edf/jobs/0000.json",
      "/vercel/sandbox/edf/jobs/0001.json",
      "/vercel/sandbox/edf/render.js",
    ]);
    expect(fake.calls.at(-1)).toBe("stop");
  });
  it("aborts (and still stops) when the VM is persistent or not deny-all", async () => {
    for (const bad of [
      { persistent: true },
      { networkPolicy: "allow-all" },
      { networkPolicy: { allow: ["*"] } },
    ]) {
      const fake = fakeSandbox(bad);
      const r = new SandboxRenderer({ snapshotId: "snap", factory: fake.factory });
      await expect(r.renderBatch([job()], { deadlineMs: 60_000 })).rejects.toBeInstanceOf(
        SandboxHygieneError,
      );
      expect(fake.calls).not.toContain("writeFiles");
      expect(fake.calls.at(-1)).toBe("stop");
    }
    expect(() =>
      assertSandboxHygiene({ persistent: false, networkPolicy: "deny-all" }),
    ).not.toThrow();
  });
  it("returns sandbox_error for every job when creation fails", async () => {
    const r = new SandboxRenderer({
      snapshotId: "snap",
      factory: vi.fn().mockRejectedValue(new Error("quota")),
    });
    const out = await r.renderBatch([job(), job("e2")], { deadlineMs: 60_000 });
    expect(out.map((o) => o.error)).toEqual(["sandbox_error", "sandbox_error"]);
  });
});

describe("orphan sweep and API metering (FREE-TIER.md §5.1 Metering)", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const vm = (over: Partial<SandboxListing> & { name: string }): SandboxListing => ({
    status: "running",
    createdAt: ago(10_000),
    updatedAt: ago(5_000),
    vcpus: 2,
    tags: { edf: "render" },
    ...over,
  });
  function ops(
    listing: SandboxListing[],
    failing: string[] = [],
  ): SandboxOps & { stopCalls: string[]; since: Date | null } {
    const o = {
      stopCalls: [] as string[],
      since: null as Date | null,
      async list({ since }: { since: Date }) {
        o.since = since;
        return listing;
      },
      async stop(name: string) {
        o.stopCalls.push(name);
        if (failing.includes(name)) throw new Error("stop failed");
      },
    };
    return o;
  }

  it("stops tagged pending/running VMs strictly older than 250 s", async () => {
    const o = ops([
      vm({ name: "young", createdAt: ago(249_000) }),
      vm({ name: "old", createdAt: ago(251_000) }),
      vm({ name: "pending", status: "pending", createdAt: ago(300_000) }),
    ]);
    const r = await sweepSandboxes(o, { now, since: ago(3_600_000) });
    expect(r.stopped).toEqual(["old", "pending"]);
    expect(o.stopCalls).toEqual(["old", "pending"]);
    expect(o.since).toEqual(ago(3_600_000));
  });
  it("never stops untagged, snapshotting or stopping VMs", async () => {
    const o = ops([
      vm({ name: "snapshot-build", tags: {}, createdAt: ago(900_000) }),
      vm({ name: "other-tag", tags: { edf: "build" }, createdAt: ago(900_000) }),
      vm({ name: "snapshotting", status: "snapshotting", createdAt: ago(900_000) }),
      vm({ name: "stopping", status: "stopping", createdAt: ago(900_000) }),
    ]);
    const r = await sweepSandboxes(o, { now, since: ago(3_600_000) });
    expect(r.stopped).toEqual([]);
    expect(o.stopCalls).toEqual([]);
    expect(r.finished).toEqual([]);
  });
  it("reports every finished VM (tagged or not) with clamped stop times and the vCPU default", async () => {
    const created = ago(200_000);
    const o = ops([
      vm({
        name: "done",
        status: "stopped",
        createdAt: created,
        updatedAt: ago(110_000),
        vcpus: 4,
      }),
      vm({
        name: "failed-untagged",
        status: "failed",
        tags: {},
        createdAt: created,
        updatedAt: ago(300_000),
        vcpus: null,
      }),
      vm({
        name: "aborted",
        status: "aborted",
        createdAt: created,
        updatedAt: created,
        vcpus: null,
      }),
    ]);
    const r = await sweepSandboxes(o, { now, since: ago(3_600_000) });
    expect(r.finished).toEqual([
      { name: "done", createdAt: created, stoppedAt: ago(110_000), vcpus: 4 },
      { name: "failed-untagged", createdAt: created, stoppedAt: created, vcpus: 2 },
      { name: "aborted", createdAt: created, stoppedAt: created, vcpus: 2 },
    ]);
    expect(sandboxUsage(r.finished[0]!)).toEqual({ wallSeconds: 90, vcpuSeconds: 360 });
  });
  it("keeps sweeping when one stop fails", async () => {
    const o = ops(
      [
        vm({ name: "a", createdAt: ago(400_000) }),
        vm({ name: "b", createdAt: ago(400_000) }),
        vm({ name: "c", createdAt: ago(400_000) }),
      ],
      ["b"],
    );
    const r = await sweepSandboxes(o, { now, since: ago(3_600_000), olderThanMs: 250_000 });
    expect(r.stopped).toEqual(["a", "c"]);
    expect(r.stopFailed).toEqual(["b"]);
  });
  it("propagates list failures to the caller", async () => {
    const o: SandboxOps = {
      list: async () => Promise.reject(new Error("api down")),
      stop: async () => undefined,
    };
    await expect(sweepSandboxes(o, { now, since: ago(1000) })).rejects.toThrow("api down");
  });
});
