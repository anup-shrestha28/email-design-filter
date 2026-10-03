/**
 * End-to-end renders with the local Chrome ($CHROME_PATH, default /usr/bin/google-chrome):
 * every design fixture against its .expected.json, adversarial fixtures never above their
 * clean twin, and the VM entry's file protocol. Skipped when no Chrome binary is present.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser } from "puppeteer-core";
import {
  fontProfile,
  prescanInjection,
  renderFeaturesSchema,
  scoreEmail,
  type CapId,
  type ScoreResult,
} from "@edf/design";
import { defaultChromePath, launchChromium } from "../src/chromium";
import { LocalChromiumRenderer } from "../src/renderer";
import { main } from "../src/vm/main";
import { jobFileName, parseResultFile } from "../src/vm/protocol";
import { type AnalyzedFixture, analyzeFixture, loadFixture } from "../scripts/fixture-lib";

const CHROME = defaultChromePath();
const HAS_CHROME = existsSync(CHROME);
const DIR = join(import.meta.dirname, "../../../fixtures/emails/design");

interface Expected {
  description: string;
  scoreRange?: [number, number];
  bands?: string[];
  capsExactly?: CapId[];
  capsInclude?: CapId[];
  checks?: Record<string, string>;
  firstNeedsImprovement?: { key: string; checkIdsInclude: string[] };
  notAboveCleanTwin?: string;
  staticChips?: string[];
  staticChipsExclude?: string[];
  fonts?: {
    outlookClassic?: string;
    warningsMatch?: string[];
    warningsExclude?: string[];
    declaredUnused?: string[];
  };
  render?: { ctaButtonLike?: number; ctaLabel?: string };
  prescanInjection?: boolean;
}

describe.skipIf(!HAS_CHROME)("end-to-end renders (local Chrome)", () => {
  let browser: Browser;
  const results = new Map<string, AnalyzedFixture>();
  const names = readdirSync(DIR)
    .filter((f) => f.endsWith(".eml"))
    .map((f) => f.replace(/\.eml$/, ""))
    .sort();

  beforeAll(async () => {
    browser = await launchChromium({ executablePath: CHROME });
    const renderer = new LocalChromiumRenderer({ browser });
    for (const n of names) results.set(n, await analyzeFixture(join(DIR, `${n}.eml`), renderer));
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("renders every fixture into schema-valid features", () => {
    for (const [n, a] of results) {
      expect(a.outcome?.error, n).toBeNull();
      expect(renderFeaturesSchema.safeParse(a.outcome?.features).success, n).toBe(true);
      expect(a.result.coverage, n).toBe("render");
      expect(
        a.result.checks.some((c) => (c.value as { reason?: string } | null)?.reason === "error"),
        n,
      ).toBe(false);
    }
  });

  it("short notifications: the grey legal footer is found, so it never caps contrast (render-2026.2)", async () => {
    const renderer = new LocalChromiumRenderer({ browser });
    for (const name of ["13-social-notification", "17-trial-ending"]) {
      const a = await analyzeFixture(join(DIR, "..", `${name}.eml`), renderer);
      const f = a.outcome!.features!;
      expect(f.footer.present, name).toBe(true);
      expect(f.text.chars.footer, name).toBeGreaterThan(100);
      expect(a.result.caps, name).not.toContain("CAP_CONTRAST");
      expect(a.result.caps, name).not.toContain("CAP_MOBILE_BROKEN");
    }
  }, 60_000);

  for (const name of readdirSync(DIR)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => f.replace(/\.expected\.json$/, ""))
    .sort()) {
    it(`${name} matches its expected outcomes`, () => {
      const exp = JSON.parse(readFileSync(join(DIR, `${name}.expected.json`), "utf8")) as Expected;
      const a = results.get(name);
      expect(a, name).toBeDefined();
      const r: ScoreResult = a!.result;
      if (exp.scoreRange) {
        expect(r.score!, `${name} score`).toBeGreaterThanOrEqual(exp.scoreRange[0]);
        expect(r.score!, `${name} score`).toBeLessThanOrEqual(exp.scoreRange[1]);
      }
      if (exp.bands) expect(exp.bands, `${name} band`).toContain(r.band);
      if (exp.capsExactly)
        expect([...r.caps].sort(), `${name} caps`).toEqual([...exp.capsExactly].sort());
      if (exp.capsInclude)
        expect(r.caps, `${name} caps`).toEqual(expect.arrayContaining(exp.capsInclude));
      for (const [id, status] of Object.entries(exp.checks ?? {})) {
        expect(r.checks.find((c) => c.id === id)?.status, `${name} ${id}`).toBe(status);
      }
      if (exp.firstNeedsImprovement) {
        const first = r.needsImprovement[0];
        expect(first?.key, `${name} first bullet`).toBe(exp.firstNeedsImprovement.key);
        expect(first?.checkIds).toEqual(
          expect.arrayContaining(exp.firstNeedsImprovement.checkIdsInclude),
        );
      }
      if (exp.staticChips)
        expect(r.staticChips.map((c) => c.code)).toEqual(expect.arrayContaining(exp.staticChips));
      for (const c of exp.staticChipsExclude ?? [])
        expect(r.staticChips.map((x) => x.code)).not.toContain(c);
      if (exp.notAboveCleanTwin) {
        const twin = results.get(exp.notAboveCleanTwin)!.result;
        expect(r.raw!, `${name} raw vs clean twin`).toBeLessThanOrEqual(twin.raw!);
        expect(r.score!, `${name} score vs clean twin`).toBeLessThanOrEqual(twin.score!);
      }
      if (exp.fonts) {
        const p = fontProfile(a!.features.fonts, { source: "render" });
        if (exp.fonts.outlookClassic)
          expect(p.clients.find((c) => c.client === "outlook_classic")?.likely).toBe(
            exp.fonts.outlookClassic,
          );
        for (const w of exp.fonts.warningsMatch ?? [])
          expect(
            p.warnings.some((x) => x.includes(w)),
            `${name} warning ${w}`,
          ).toBe(true);
        for (const w of exp.fonts.warningsExclude ?? [])
          expect(
            p.warnings.some((x) => x.includes(w)),
            `${name} no warning ${w}`,
          ).toBe(false);
        if (exp.fonts.declaredUnused) expect(p.declaredUnused).toEqual(exp.fonts.declaredUnused);
      }
      if (exp.render) {
        const f = a!.outcome!.features!;
        if (exp.render.ctaButtonLike !== undefined)
          expect(f.cta.buttonLike).toBe(exp.render.ctaButtonLike);
        if (exp.render.ctaLabel) expect(f.cta.primary?.label).toBe(exp.render.ctaLabel);
      }
      if (exp.prescanInjection) {
        const f = a!.fixture;
        expect(prescanInjection(`${f.parsed.subject ?? ""}\n${f.parsed.html ?? ""}`)).toBe(true);
      }
    });
  }

  it("the explanation of a template-level score keeps static facts of the email itself", () => {
    const clean = results.get("01-excellent-promo")!;
    const merge = results.get("07-merge-tag")!;
    const inherited = {
      ...merge.features,
      render: clean.features.render,
      renderSource: "template" as const,
    };
    const r = scoreEmail(inherited, merge.fixture.scoreCtx);
    expect(r.coverage).toBe("template");
    expect(r.caps).toContain("CAP_MERGE_TAG");
  });

  it("the VM entry renders job files and writes results that validate as untrusted input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edf-vm-"));
    try {
      const jobs = join(dir, "jobs");
      mkdirSync(jobs);
      const f = await loadFixture(join(DIR, "01-excellent-promo.eml"));
      const job = { ...f.job, wantAiTiles: true };
      writeFileSync(
        join(jobs, jobFileName(0)),
        JSON.stringify({ v: 1, job, deadlineAt: Date.now() + 60_000 }),
      );
      writeFileSync(join(jobs, jobFileName(1)), "{ not json");
      const prev = process.env.EDF_CHROME_PATH;
      process.env.EDF_CHROME_PATH = CHROME;
      const writes: string[] = [];
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let code: number;
      try {
        code = await main([jobs, join(dir, "out")]);
      } finally {
        process.stdout.write = orig;
        if (prev === undefined) delete process.env.EDF_CHROME_PATH;
        else process.env.EDF_CHROME_PATH = prev;
      }
      expect(code).toBe(0);
      expect(writes.join("")).toBe("EDF 0 ok\nEDF 1 parse_error\n");
      const out = parseResultFile(
        new Uint8Array(readFileSync(join(dir, "out", jobFileName(0)))),
        job,
      );
      expect(out.ok).toBe(true);
      expect(out.aiTiles?.desktop.length).toBeGreaterThanOrEqual(1);
      expect(out.aiTiles?.mobile).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
