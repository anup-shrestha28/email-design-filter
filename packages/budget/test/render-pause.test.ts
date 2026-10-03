/**
 * The governor → on-demand render pause rule (FREE-TIER.md §5.3 on demand, §8.2 L2/L3, §8.3
 * Sandbox), from real `computeGovernor` output: the owner's "Analyze" keeps working at L2 and the
 * Sandbox self-cap, friends' doesn't; nobody's runs at L3 or the Sandbox static-only stage. Pure: no
 * database, no pipeline.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  calendarMonthStart,
  computeGovernor,
  FREE_TIER_PROFILE,
  onDemandPausedReason,
  renderGovernorOf,
  rendersStopped,
  RESOURCES as R,
  type RenderGovernor,
} from "../src/index";

const NOW = new Date("2026-09-20T12:00:00Z");

function governorFor(r30: Record<string, number>, neonCuHoursMtd = 0): RenderGovernor {
  const g = computeGovernor({
    usage: { rolling30d: r30, monthToDate: {}, trailing7dAvg: {} },
    neonCuHoursMtd,
    neonStorageMb: 50,
    calibration: {},
    profile: FREE_TIER_PROFILE,
    now: NOW,
    periodStart: calendarMonthStart(NOW),
    previous: null,
  });
  // What app_setting.governor stores, read back the way the app reads it.
  return renderGovernorOf(JSON.parse(JSON.stringify({ level: g.level, actions: g.actions })));
}

const FRIENDS = /^Design renders for friends are paused .* They resume on their own when usage drops\.$/;
const EVERYONE = /^Design renders are paused for everyone .* They resume on their own when usage drops\.$/;

describe("onDemandPausedReason", () => {
  it("runs for everyone at L0, at L1 and at the Sandbox soft cap (only fill renders stop there)", () => {
    for (const gov of [governorFor({}), governorFor({}, 50), governorFor({ [R.sandboxCpuS]: 10_080 })]) {
      expect(rendersStopped(gov)).toBe(false);
      expect(gov.actions.plannedRendersOff).toBeFalsy();
      for (const role of ["owner", "friend", null] as const) expect(onDemandPausedReason(gov, role)).toBeNull();
    }
    expect(governorFor({}, 50).level).toBe(1);
    expect(governorFor({}, 50).actions.fillRendersOff).toBe(true);
  });

  it("pauses friends but not the owner at the Sandbox self-cap and at L2 (Neon 60 CU-h)", () => {
    for (const gov of [governorFor({ [R.sandboxCpuS]: 13_000 }), governorFor({}, 60)]) {
      expect(gov.actions.plannedRendersOff).toBe(true);
      expect(rendersStopped(gov)).toBe(false);
      expect(onDemandPausedReason(gov, "owner")).toBeNull();
      expect(onDemandPausedReason(gov, "friend")).toMatch(FRIENDS);
      // An unknown role is never treated as the owner.
      expect(onDemandPausedReason(gov, null)).toMatch(FRIENDS);
    }
    expect(governorFor({}, 60).level).toBe(2);
  });

  it("pauses everyone, the owner too, at the Sandbox static-only stage and at L3 (Neon 80 CU-h)", () => {
    for (const gov of [governorFor({ [R.sandboxCpuS]: 16_200 }), governorFor({}, 80)]) {
      expect(rendersStopped(gov)).toBe(true);
      for (const role of ["owner", "friend", null] as const) expect(onDemandPausedReason(gov, role)).toMatch(EVERYONE);
    }
    expect(governorFor({}, 80).level).toBe(3);
  });
});

describe("renderGovernorOf", () => {
  it("reads a missing or partial app_setting.governor as L0 with every switch off", () => {
    for (const v of [undefined, null, {}, { level: 0, since: null, triggers: [], belowSince: null }]) {
      const gov = renderGovernorOf(v);
      expect(gov).toEqual({ level: 0, actions: {} });
      expect(onDemandPausedReason(gov, "friend")).toBeNull();
    }
  });

  it("honours a level stored as text and the switches on their own", () => {
    expect(rendersStopped(renderGovernorOf({ level: "3" as unknown as number }))).toBe(true);
    expect(onDemandPausedReason(renderGovernorOf({ level: 0, actions: { rendersOff: true } }), "owner")).toMatch(EVERYONE);
    expect(onDemandPausedReason(renderGovernorOf({ level: 0, actions: { plannedRendersOff: true } }), "owner")).toBeNull();
    expect(onDemandPausedReason(renderGovernorOf({ level: 0, actions: { plannedRendersOff: true } }), "friend")).toMatch(FRIENDS);
  });
});

describe("render-pause module", () => {
  it("has no runtime imports, so the email page can use it without loading the pipeline", () => {
    const src = readFileSync(new URL("../src/render-pause.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^\s*import\s/.test(l) || /\bimport\(/.test(l));
    expect(imports.every((l) => /^\s*import\s+type\s/.test(l))).toBe(true);
  });
});
