/**
 * Render a fixture with the local Chrome, score it and print the explanation.
 *
 *   pnpm --filter @edf/render exec tsx scripts/render-fixture.ts <file.eml> [--static] [--json]
 *
 * Uses $CHROME_PATH (default /usr/bin/google-chrome). Development tool: prints the fixture's
 * content (subject, labels) — never run it on real user mail.
 */
import { fontCardLines } from "@edf/design";
import { LocalChromiumRenderer } from "../src/renderer";
import { analyzeFixture } from "./fixture-lib";

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: render-fixture.ts <file.eml> [--static] [--json]");
    process.exit(2);
  }
  const renderer = args.includes("--static") ? null : new LocalChromiumRenderer();
  const a = await analyzeFixture(file, renderer);
  const r = a.result;
  if (args.includes("--json")) {
    console.log(JSON.stringify({ result: r, render: a.outcome?.error ?? "ok" }, null, 2));
    return;
  }
  if (a.outcome && !a.outcome.ok) console.log(`render failed: ${a.outcome.error}`);
  const scoreText =
    r.score === null
      ? "Design not analysed yet (static checks only)"
      : `${r.score} / 100${r.capped ? ` (capped · raw ${r.raw})` : ""}`;
  console.log(
    `\nEmail Design Score: ${scoreText} · ${r.band ?? "—"} · confidence ${r.confidenceBand} (${r.confidence.toFixed(3)})${r.provisional ? " · Provisional" : ""}${r.aiPending ? " · AI review pending" : ""}`,
  );
  console.log(`Coverage: ${r.coverage} · ${r.scoringVersion}`);
  if (r.pillars.length > 0)
    console.log(
      r.pillars.map((p) => `${p.label} ${p.points.toFixed(1)}/${p.max.toFixed(1)}`).join(" · "),
    );
  if (r.caps.length > 0) console.log(`Caps: ${r.caps.join(", ")}`);
  if (r.staticChips.length > 0)
    console.log(`Chips: ${r.staticChips.map((c) => c.label).join(" · ")}`);
  console.log("\nNeeds improvement");
  for (const i of r.needsImprovement)
    console.log(` ✗ ${i.title}  [−${i.points.toFixed(1)}]${i.ai ? " [AI review]" : ""}`);
  console.log("\nGood");
  for (const i of r.good)
    console.log(` ✓ ${i.title}  [+${i.points.toFixed(1)}]${i.ai ? " [AI review]" : ""}`);
  console.log("\nFonts");
  for (const line of fontCardLines(a.profile)) console.log(` ${line}`);
  if (a.outcome)
    console.log(`\nrendered in ${a.outcome.renderMs} ms · ${a.outcome.chromiumVersion ?? ""}`);
}

run().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "failed");
  process.exit(1);
});
